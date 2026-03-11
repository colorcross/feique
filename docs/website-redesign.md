# 官网改版记录

## 这轮为什么重做

旧官网的问题不是“信息不全”，而是更像文档首页：

- npm 已发布，但首页没有把安装路径提到足够高的位置
- 最近几轮最关键的能力更新，例如 `chat_id` 项目绑定、`/session adopt`、`project.root` 串行、`queued` 可见状态，没有进入首页主叙事
- 视觉上过于平，没有形成“这是一个有控制面、有运行纪律的工程桥接器”的品牌感

## 参考对象

本轮明确参考了 `openclaw.ai` 的信息组织方式，但没有直接照搬它的品牌语言或视觉风格。

参考的是这些结构性优点：

- 首屏标题更短、更直接
- 安装路径在首页更靠前
- 首页不只讲“它是什么”，也讲“它现在已经能稳定做什么”
- 模块节奏更像产品官网，而不是目录页

## 这轮最终采用的方向

方向：`Control Plane Product Page`

核心原则：

1. 首页先说明“这是什么控制面”，再进入文档
2. npm、GitHub Release、Docs、Pages 四个外部表面要在首页同层可见
3. 最近的产品变化必须直接进入首页模块，而不是只留在 README 和对话里
4. 不引入构建工具，继续保持纯静态 HTML/CSS

## 首页现在的模块

1. `announcement bar`
   - 说明 npm 已上线，release 流程已打通
2. `hero`
   - 用更短、更强的标题说明定位
   - 直接给出 npm 安装和文档入口
3. `runtime preview`
   - 同时展示 CLI 安装命令和 `queued` 运行态示例
4. `signal rail`
   - 用四个高密度模块说明绑定、续接、串行和上下文扩展
5. `workflow`
   - 讲清消息进入桥接层后的真实流向
6. `capabilities`
   - 把最近几轮迭代的具体能力明确列出来
7. `quick start`
   - 首页直接放 CLI 和飞书命令
8. `docs surface`
   - README、FAQ、Architecture、Releases、Discussions 统一放在一层

## 仍然保留的约束

- 纯静态站点
- GitHub Pages 兼容
- 中英文双页
- 不使用重型动画或构建工具
- 不伪造用户评价、媒体报道或数据指标

## 后续可继续增强的点

1. 增加真实飞书卡片 / 终端运行截图
2. 把社交预览图做成专门的分享构图，而不只是首页截图
3. 增加 release timeline 或 capability matrix
4. 如果后续有真实外部用户反馈，再考虑增加 proof section
