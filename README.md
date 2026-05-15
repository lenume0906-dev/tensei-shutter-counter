# 北斗転生カウンター

パチスロ「北斗の拳 転生」のセッションデータを記録するPWAアプリ。

- 入力データをIndexedDBにローカル保存
- Google Apps Script経由でGoogleスプレッドシートにバックアップ
- オフライン対応・ホーム画面追加可能（PWA）

---

## セットアップ手順

### 1. アイコンの生成

```
generate-icons.html をブラウザで開く
→ 2つのPNGをダウンロード
→ icons/ フォルダに配置
```

```
icons/
├── icon-192.png
└── icon-512.png
```

### 2. ローカル確認

```bash
# Python 3
python3 -m http.server 8000

# または Node.js
npx serve .
```

ブラウザで `http://localhost:8000` を開く。

### 3. GAS URLの変更（必要な場合）

`app.js` 冒頭の定数を自分のものに変更：

```javascript
const GAS_URL    = 'https://script.google.com/macros/s/...your-id.../exec';
const SECRET_KEY = 'your-secret-key';
```

---

## GitHub Pages へのデプロイ

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

GitHub リポジトリの **Settings → Pages → Source: main ブランチ** を選択して Save。

数分後に `https://<user>.github.io/<repo>/` でアクセス可能になります。

### iPhoneでホーム画面に追加

1. Safari でアプリのURLを開く
2. 共有ボタン → **「ホーム画面に追加」**
3. ホーム画面のアイコンから起動 → スタンドアロンモードで動作

---

## ファイル構成

```
/
├── index.html          メイン画面
├── style.css           スタイル（ダークテーマ）
├── app.js              アプリロジック・IndexedDB・GAS通信
├── manifest.json       PWAマニフェスト
├── service-worker.js   オフラインキャッシュ
├── generate-icons.html アイコン生成ツール（デプロイ不要）
└── icons/
    ├── icon-192.png    PWAアイコン（要生成）
    └── icon-512.png    PWAアイコン（要生成）
```

---

## GASエンドポイント仕様

### POST（セッション追記）

```json
{
  "secret": "16384",
  "id": "uuid-v4",
  "timestamp": "2026-05-16T14:30:00+09:00",
  "start_rotation": 100,
  "win_count": 5,
  "abeshi_count": 2,
  "end_rotation": 1500,
  "invest_coins": 1000,
  "return_coins": 1800,
  "note": ""
}
```

`Content-Type: text/plain;charset=utf-8` で送信（CORSプリフライト回避）。

### GET（全セッション取得）

```
GET {GAS_URL}?secret=16384
→ {"ok":true,"sessions":[...]}
```

---

## 計算式

| 指標 | 計算式 |
|------|--------|
| 総回転数 | `end_rotation − start_rotation` |
| 収支 | `return_coins − invest_coins` |
| 初当たり確率 | `総回転数 ÷ win_count`（表示: `1/X.X`形式） |
| 機械割 | `(総回転数×3 + return_coins − invest_coins) ÷ (総回転数×3) × 100` |

累計の確率・機械割は全セッションの生データから再計算（単純平均ではない）。
