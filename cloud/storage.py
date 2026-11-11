"""配置存储：本地文件后端 + 可选 OSS 后端。

FC 是无状态的，配置必须外置。本模块提供：
- FileStorage：本地/单机开发、自建服务器，原子替换 + 进程内锁。
- OSSStorage：阿里云 OSS（需 oss2），与 FC 搭配使用。
两种后端都维护 current.json 与 history/<revision>.json 快照，
写入采用乐观锁（expected_revision），冲突抛 Conflict → HTTP 409。
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from .schema import ConfigError, build_document, now_iso, seed_document


class Conflict(Exception):
    """revision 不匹配。"""

    def __init__(self, current: dict):
        super().__init__("配置已被其他设备修改")
        self.current = current


class Storage:
    def read(self) -> dict:
        raise NotImplementedError

    def write(self, sections: dict, expected_revision: int) -> dict:
        raise NotImplementedError

    def revisions(self, limit: int = 20) -> list[dict]:
        raise NotImplementedError

    def read_revision(self, revision: int) -> dict | None:
        raise NotImplementedError

    def rollback(self, revision: int) -> dict:
        snapshot = self.read_revision(revision)
        if snapshot is None:
            raise ConfigError("找不到 revision %d 的快照" % revision)
        current = self.read()
        return self.write(snapshot["sections"], current["revision"])


def _history_name(revision: int) -> str:
    return "history/%08d.json" % revision


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _encode(document: dict) -> bytes:
    return (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


class FileStorage(Storage):
    """本地 JSON 文件后端。data/current.json + data/history/*.json。"""

    def __init__(self, data_dir: str | Path | None = None):
        root = Path(__file__).resolve().parent.parent
        self.dir = Path(data_dir) if data_dir else root / "data"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.current_path = self.dir / "current.json"
        self.history_dir = self.dir / "history"
        self._lock = threading.Lock()

    def read(self) -> dict:
        with self._lock:
            if not self.current_path.exists():
                document = seed_document()
                _atomic_write(self.current_path, _encode(document))
                return document
            try:
                with self.current_path.open("r", encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError) as exc:
                raise RuntimeError("配置文档损坏: %s" % exc) from exc

    def write(self, sections: dict, expected_revision: int) -> dict:
        with self._lock:
            current = self._read_unlocked()
            if current["revision"] != expected_revision:
                raise Conflict(current)
            document = build_document(sections, expected_revision + 1, now_iso())
            payload = _encode(document)
            # 先写不可变快照，再原子切换 current，避免 current 指向不存在的历史。
            _atomic_write(self.dir / _history_name(document["revision"]), payload)
            _atomic_write(self.current_path, payload)
            return document

    def _read_unlocked(self) -> dict:
        if not self.current_path.exists():
            document = seed_document()
            _atomic_write(self.current_path, _encode(document))
            return document
        with self.current_path.open("r", encoding="utf-8") as fh:
            return json.load(fh)

    def revisions(self, limit: int = 20) -> list[dict]:
        if not self.history_dir.exists():
            return []
        items = []
        for path in sorted(self.history_dir.glob("*.json"), reverse=True)[: max(1, min(limit, 100))]:
            try:
                with path.open("r", encoding="utf-8") as fh:
                    document = json.load(fh)
                items.append({
                    "revision": document.get("revision"),
                    "updatedAt": document.get("updatedAt"),
                    "size": path.stat().st_size,
                })
            except (OSError, ValueError):
                continue
        return items

    def read_revision(self, revision: int) -> dict | None:
        path = self.dir / _history_name(revision)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None


class OSSStorage(Storage):
    """阿里云 OSS 后端，需安装 oss2（见 requirements.txt）。

    FC 多实例并发写时，OSS 没有跨实例 CAS 原语；本实现采用「读-比较-写」
    乐观锁，适合单写入者 / 个人规模。多写入者场景请改用 Tablestore 原子计数
    或在函数配置中把实例并发上限设为 1。
    """

    def __init__(self, env: dict[str, str] | None = None):
        cfg = env if env is not None else dict(os.environ)
        try:
            import oss2  # type: ignore
        except ImportError as exc:
            raise RuntimeError("OSS 后端需要 oss2：pip install -r requirements.txt") from exc
        endpoint = cfg.get("OSS_ENDPOINT", "")
        bucket_name = cfg.get("OSS_BUCKET", "")
        if not endpoint or not bucket_name:
            raise RuntimeError("OSS_ENDPOINT / OSS_BUCKET 未配置")
        auth = oss2.Auth(cfg.get("OSS_ACCESS_KEY_ID", ""),
                         cfg.get("OSS_ACCESS_KEY_SECRET", ""))
        self._oss2 = oss2
        self.bucket = oss2.Bucket(auth, endpoint, bucket_name)
        self.prefix = cfg.get("OSS_PREFIX", "pure_live_tv/").rstrip("/") + "/"
        self._lock = threading.Lock()

    def _key(self, name: str) -> str:
        return self.prefix + name

    def _get(self, name: str) -> dict | None:
        try:
            data = self.bucket.get_object(self._key(name)).read()
        except self._oss2.exceptions.NoSuchKey:
            return None
        return json.loads(data.decode("utf-8"))

    def _put(self, name: str, document: dict) -> None:
        self.bucket.put_object(self._key(name), _encode(document))

    def read(self) -> dict:
        with self._lock:
            document = self._get("current.json")
            if document is None:
                document = seed_document()
                self._put("current.json", document)
            return document

    def write(self, sections: dict, expected_revision: int) -> dict:
        with self._lock:
            current = self._get("current.json") or seed_document()
            if current["revision"] != expected_revision:
                raise Conflict(current)
            document = build_document(sections, expected_revision + 1, now_iso())
            self._put(_history_name(document["revision"]), document)
            self._put("current.json", document)
            return document

    def revisions(self, limit: int = 20) -> list[dict]:
        prefix = self._key("history/")
        items = []
        for obj in self._oss2.ObjectIterator(self.bucket, prefix=prefix):
            name = obj.key.rsplit("/", 1)[-1]
            if not name.endswith(".json"):
                continue
            try:
                items.append({
                    "revision": int(name[:-5]),
                    "updatedAt": getattr(obj, "last_modified", ""),
                    "size": obj.size,
                })
            except ValueError:
                continue
        return sorted(items, key=lambda item: item["revision"], reverse=True)[: max(1, min(limit, 100))]

    def read_revision(self, revision: int) -> dict | None:
        return self._get(_history_name(revision))


def create_storage(env: dict[str, str] | None = None) -> Storage:
    cfg = env if env is not None else dict(os.environ)
    backend = cfg.get("CONFIG_STORAGE_BACKEND", "file").strip().lower()
    if backend == "oss":
        return OSSStorage(cfg)
    if backend != "file":
        raise RuntimeError("未知 CONFIG_STORAGE_BACKEND: %s" % backend)
    return FileStorage(cfg.get("CONFIG_DATA_DIR"))
