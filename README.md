# 珠海 · 大吃特吃

共享的「吃到哪了」清单。打开 → 点菜名打勾 → 每条可填地址 → 自动同步。
状态存在一个 **secret Gist**，仓库里没有数据文件。

## 目录

```
index.html               结构（head 里按顺序挂 4 个样式表）
styles/fonts.css         @font-face（10 个 face，指向 ../assets/fonts/*.woff2）
styles/base.css          GZ:TOKENS + magazine 版式 + ui overlay（三段原样拼接，顺序不可换）
styles/app.css           清单组件：基础 → 同步补丁 → 卡片补丁（顺序不可换）
styles/deco.css          整页装饰：纸纹、页边菱形纹、同心弧角、菱形分隔线
scripts/toc.js           目录抽屉（当前被隐藏，保留）
scripts/app.js           清单 + Gist 同步
assets/fonts/*.woff2     10 个字体，共 666,324 B
tools/extract-fonts.mjs  从原内嵌 base64 解出 woff2 并生成 fonts.css
tools/split.mjs          原单文件拆分脚本（一次性，留档）
```

## 不可违反的约定

1. **样式加载顺序固定**：`fonts → base → app → deco`。`base` 里 6 个选择器与 `app` 同名，靠靠后取胜；`deco` 最后覆盖装饰。
2. **本页已脱离 `guizang-page-skill` 生成链**：不要重跑 `render.mjs`，它会整页重建并抹掉 `#cdp` 面板与同步脚本。
3. **字体是子集字形**：改文案加入新汉字后，可能出现回退系统字体；需要重跑子集化再替换 woff2。
4. **必须走 HTTP**（GitHub Pages 或本地静态服务器）。`file://` 直开时字体会被 CORS 拒绝。
5. GitHub Pages 缓存约 `max-age=600`，推送后最多约 10 分钟生效。

## 部署

GitHub Pages 静态站。本地起服务预览：`python -m http.server 8899`，打开 `http://127.0.0.1:8899/`。
