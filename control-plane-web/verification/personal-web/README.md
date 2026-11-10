# Personal Web 真实执行验证

本目录验证已构建 Web → 同源 BFF → 真实 ACS Session/Message → Product → 隔离工作树。
模型是本机 HTTP 协议夹具，返回固定工具调用和 usage；不调用外部付费模型。
不替换任务创建、调度、工具执行、验证或观测入库。

需要当前工作区中的 AgentCodeService、AgentProducts、AgentFramework，JDK 21、Node、Python，
以及已安装的 Web 依赖和 Playwright Chromium。构建复用 ACS 的 `target/dependency`，不发布 Maven 制品。

从 `<repo>/apps/control-plane-web` 执行，输出目录必须未存在：

```powershell
pnpm management:build
python verification/personal-web/build-runtime.py --workspace D:/project/workspace --output .local/personal-web-runtime-new
python verification/personal-web/run-acceptance.py --runtime .local/personal-web-runtime-new --output .local/personal-web-observed-new
python verification/personal-web/run-acceptance.py --runtime .local/personal-web-runtime-new --output .local/personal-web-unobserved-new --without-observation
```

`build-runtime.py` 记录参与源码与依赖摘要，并复制真实 ServiceLoader 资源。
`run-acceptance.py` 使用独立端口、管理库、状态目录和 JVM user.home；临时协议凭据只在父子进程内存管道传递。
它只停止自己启动的进程，不修改中央环境配置。正式安装的秘密仍只能通过中央 env helper 供给。

验证依次包含项目名称选择、自动登记、启动、源端完成、详情刷新、另一标签页发现原任务、
真正重启 BFF 后恢复同一 Session/Run，以及旧管理任务导航跳转。检查原 checkout 保持 v1、
隔离工作树变为 v2；开启观测时读取报告 token，关闭时所有用量为 null。报告、daemon、Docker 均未接入。

输出包括 `acceptance.json`、`browser-result.json`、`restart-result.json`、截图与局部日志。
失败目录保留原状；修复后使用新的输出目录，不覆盖失败记录。协议模型通过不代表外部模型质量、真实账单或部署资格。
