# 官网部署说明

静态官网源码在：

- `website/index.html`
- `website/styles.css`
- `website/favicon.svg`

它不依赖构建工具，可以直接托管到任意静态服务。

当前 GitHub 仓库地址：

- <https://github.com/colorcross/codex-feishu>

推荐 GitHub Pages 地址：

- <https://colorcross.github.io/codex-feishu/>

## 本地预览

最简单的方式：

1. 直接双击打开 `website/index.html`
2. 或者用任意静态文件服务器指向 `website/`

例如：

```bash
cd website
python3 -m http.server 8080
```

然后访问：

- `http://127.0.0.1:8080`

## 发布到 GitHub Pages

### 方案 A：使用仓库内置 GitHub Actions

仓库已经补了 Pages workflow：

- `.github/workflows/pages.yml`

行为：

- `push` 到 `main` 时自动发布
- 发布目录固定为 `website/`
- 发布目标是 GitHub Pages

### 方案 B：发布到 `docs/` 或单独分支

如果你不想用 Actions，也可以把 `website/` 内容复制到 `docs/` 或 `gh-pages` 分支。

## 官网内容建议

现在这版官网已经包含：

- 核心价值主张
- 双模式运行对比
- 项目能力矩阵
- 典型命令
- 文档与仓库入口链接

如果后续要进一步增强，优先建议：

1. 增加真实截图或终端录屏
2. 增加架构图 SVG
3. 增加 GitHub Releases / npm 安装入口
4. 补英文版着陆页
