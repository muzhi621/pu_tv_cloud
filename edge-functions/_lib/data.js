// 本文件由 scripts/build_edgeone_assets.py 生成，请勿手改。
// 数据源：config/seed.json、config/site_catalog.json

export const SCHEMA_VERSION = 1;

export const SEED = {
  "schemaVersion": 1,
  "revision": 0,
  "updatedAt": "2026-01-01T00:00:00+08:00",
  "sections": {
    "navigation": {
      "managed": false,
      "railMenuIds": [
        "iptv",
        "vodBrowse",
        "moviePlayback"
      ],
      "groups": [
        {
          "id": "iptv",
          "label": "IPTV",
          "icon": "live_tv",
          "children": [
            "iptv"
          ]
        },
        {
          "id": "vod",
          "label": "影音",
          "icon": "movie",
          "children": [
            "vodBrowse",
            "moviePlayback"
          ]
        },
        {
          "id": "settings",
          "label": "设置",
          "icon": "settings",
          "children": [
            "settings"
          ]
        }
      ],
      "defaultGroupId": "iptv",
      "sidebarExpanded": false,
      "homeKeepAlive": true,
      "settings": {
        "managed": false,
        "enabledEntryPaths": []
      },
      "wallpaper": {
        "enabled": false,
        "imageUrl": "",
        "boxFit": "cover",
        "blurSigma": 0,
        "maskOpacityPercent": 35
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
      "exitDialog": {
        "enabled": false,
        "mode": "always",
        "dismissible": true,
        "showDonate": true,
        "titleI18n": {},
        "bodyI18n": {},
        "qrImageUrl": "",
        "qrCaptionI18n": {},
        "donateBodyI18n": {},
        "confirmTextI18n": {},
        "cancelTextI18n": {}
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
    },
    "iptv": {
      "managed": false,
      "sources": [],
      "groups": [],
      "channels": [],
      "epgUrl": "",
      "packages": [],
      "selectedPackageIds": []
    }
  }
};

export const CATALOG = {
  "schemaVersion": 1,
  "sites": [],
  "menus": [
    {
      "id": "vodBrowse",
      "name": "影视点播"
    },
    {
      "id": "moviePlayback",
      "name": "链接放映"
    },
    {
      "id": "iptv",
      "name": "IPTV 频道"
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
