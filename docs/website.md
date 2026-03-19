# 官网部署说明

静态官网源码在：

- `website/index.html`
- `website/en.html`
- `website/styles.css`
- `website/favicon.svg`
- `website/social-preview.png`

它仍然是纯静态站点，不依赖构建工具，继续兼容 GitHub Pages。

当前线上地址：

- 中文：<https://colorcross.github.io/feique/>
- 英文：<https://colorcross.github.io/feique/en.html>

## 当前官网信息架构

新版首页不再只是“文档入口页”，而是更明确的产品控制面介绍页，首页现在突出：

- npm 已发布，安装路径明确可见
- `chat_id` 项目绑定、`/session adopt`、`project.root` 串行和 `queued` 状态这些关键能力
- 首页直接展示安装命令、飞书命令和运行态示例
- README / docs / Releases / npm 入口放在同一层导航里

## 本地预览

推荐用静态文件服务器，而不是直接双击 HTML：

```bash
cd website
python3 -m http.server 8080
```

然后访问：

- <http://127.0.0.1:8080>
- <http://127.0.0.1:8080/en.html>

## 发布到 GitHub Pages

仓库内置 workflow：

- `.github/workflows/pages.yml`

行为：

- `push` 到 `main` 时自动发布
- 发布目录固定为 `website/`
- `workflow_dispatch` 可手动重发

## 社交预览图

仓库内已经保留两份可上传的社交预览图：

- `website/social-preview.png`
- `.github/assets/social-preview.png`

GitHub 仓库 Settings 里的 Social preview 仍需要手动上传一次：

1. 打开仓库 `Settings`
2. 进入 `General`
3. 找到 `Social preview`
4. 上传 `website/social-preview.png` 或 `.github/assets/social-preview.png`

## 同步原则

官网更新时，至少同时核对这几处：

1. `README.md` / `README.en.md`
2. `docs/getting-started.md`
3. `docs/faq.md`
4. `.github/workflows/pages.yml`
5. `.github/workflows/release.yml`

如果首页改了安装方式、发布方式、项目路由、session 机制或运行态结论，这几处不应继续保留旧口径。
