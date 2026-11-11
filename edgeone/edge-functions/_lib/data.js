// 本文件由 scripts/build_edgeone_assets.py 生成，请勿手改。
// 数据源：config/seed.json、config/site_catalog.json

export const SCHEMA_VERSION = 1;

export const SEED = {
  "schemaVersion": 1,
  "revision": 0,
  "updatedAt": "2026-01-01T00:00:00+08:00",
  "sections": {
    "sites": {
      "managed": false,
      "policy": "whitelist",
      "enabledSiteIds": [
        "weibo",
        "niconico",
        "bilibili",
        "douyu",
        "huya",
        "douyin",
        "kuaishou",
        "cc",
        "iptv",
        "twitch",
        "soop",
        "yy",
        "acfun",
        "picarto",
        "twitcasting",
        "missevan",
        "inke",
        "kilakila",
        "xiaohongshu",
        "showroom",
        "chzzk",
        "kick",
        "liveme",
        "tiktok",
        "youtube",
        "bigo",
        "pandalive",
        "fc2live",
        "steambroadcast",
        "jdlive",
        "kugoulive",
        "baidulive",
        "looklive",
        "17live",
        "sixroom"
      ]
    },
    "navigation": {
      "managed": false,
      "railMenuIds": [
        "favorite",
        "hot",
        "areas",
        "favoriteAreas",
        "moviePlayback",
        "search",
        "history"
      ],
      "sidebarExpanded": false,
      "homeKeepAlive": true,
      "settings": {
        "managed": false,
        "enabledEntryPaths": []
      }
    },
    "startup": {
      "managed": false,
      "agreement": {
        "enabled": true,
        "requiredVersion": 1,
        "titleI18n": {},
        "bodyI18n": {}
      },
      "notice": {
        "enabled": false,
        "mode": "once_per_revision",
        "dismissible": true,
        "titleI18n": {},
        "bodyI18n": {}
      },
      "showSplashPage": true
    },
    "update": {
      "managed": false,
      "autoCheck": true,
      "checkIntervalHours": 24,
      "prompt": "dialog",
      "minSupportedVersion": "",
      "allowPrerelease": false,
      "allowUserOverride": true,
      "mirrorUrls": [],
      "changelogI18n": {}
    }
  }
};

export const CATALOG = {
  "schemaVersion": 1,
  "sites": [
    {
      "id": "weibo",
      "name": "微博直播",
      "retired": false
    },
    {
      "id": "niconico",
      "name": "niconico",
      "retired": false
    },
    {
      "id": "bilibili",
      "name": "哔哩哔哩",
      "retired": false
    },
    {
      "id": "douyu",
      "name": "斗鱼",
      "retired": false
    },
    {
      "id": "huya",
      "name": "虎牙",
      "retired": false
    },
    {
      "id": "douyin",
      "name": "抖音",
      "retired": false
    },
    {
      "id": "kuaishou",
      "name": "快手",
      "retired": false
    },
    {
      "id": "cc",
      "name": "网易CC",
      "retired": false
    },
    {
      "id": "iptv",
      "name": "网络",
      "retired": false
    },
    {
      "id": "twitch",
      "name": "Twitch",
      "retired": false
    },
    {
      "id": "soop",
      "name": "Soop",
      "retired": false
    },
    {
      "id": "yy",
      "name": "YY",
      "retired": false
    },
    {
      "id": "acfun",
      "name": "AcFun 直播",
      "retired": false
    },
    {
      "id": "picarto",
      "name": "Picarto",
      "retired": false
    },
    {
      "id": "twitcasting",
      "name": "TwitCasting",
      "retired": false
    },
    {
      "id": "missevan",
      "name": "猫耳 FM",
      "retired": false
    },
    {
      "id": "inke",
      "name": "映客",
      "retired": false
    },
    {
      "id": "kilakila",
      "name": "克拉克拉",
      "retired": false
    },
    {
      "id": "xiaohongshu",
      "name": "小红书",
      "retired": false
    },
    {
      "id": "showroom",
      "name": "SHOWROOM",
      "retired": false
    },
    {
      "id": "chzzk",
      "name": "CHZZK",
      "retired": false
    },
    {
      "id": "kick",
      "name": "Kick",
      "retired": false
    },
    {
      "id": "liveme",
      "name": "LiveMe",
      "retired": false
    },
    {
      "id": "tiktok",
      "name": "TikTok LIVE",
      "retired": false
    },
    {
      "id": "youtube",
      "name": "YouTube Live",
      "retired": false
    },
    {
      "id": "bigo",
      "name": "Bigo Live",
      "retired": false
    },
    {
      "id": "pandalive",
      "name": "PandaTV",
      "retired": false
    },
    {
      "id": "fc2live",
      "name": "FC2 Live",
      "retired": false
    },
    {
      "id": "steambroadcast",
      "name": "Steam Broadcasts",
      "retired": false
    },
    {
      "id": "jdlive",
      "name": "京东直播",
      "retired": false
    },
    {
      "id": "kugoulive",
      "name": "酷狗直播",
      "retired": false
    },
    {
      "id": "baidulive",
      "name": "百度直播",
      "retired": false
    },
    {
      "id": "looklive",
      "name": "LOOK 直播",
      "retired": false
    },
    {
      "id": "17live",
      "name": "17LIVE",
      "retired": false
    },
    {
      "id": "sixroom",
      "name": "六间房直播",
      "retired": false
    }
  ],
  "menus": [
    {
      "id": "favorite",
      "name": "直播关注"
    },
    {
      "id": "hot",
      "name": "热门直播"
    },
    {
      "id": "areas",
      "name": "分区类别"
    },
    {
      "id": "favoriteAreas",
      "name": "关注分区"
    },
    {
      "id": "moviePlayback",
      "name": "链接放映"
    },
    {
      "id": "search",
      "name": "搜索"
    },
    {
      "id": "history",
      "name": "历史记录"
    }
  ],
  "updatePrompts": [
    "silent",
    "dialog",
    "force"
  ],
  "noticeModes": [
    "once_per_revision",
    "always",
    "never"
  ],
  "settingsEntryPaths": []
};
