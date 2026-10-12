import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import Layout from "@theme/Layout";
import type { ReactElement } from "react";
import styles from "./index.module.css";

const entryPoints = [
  {
    title: "普通用户",
    kicker: "CLI / TUI",
    body: "查看 GPU、提交 Slurm 作业、打开交互 shell、生成 Web token 和配置提醒。",
    to: "/docs/user-guide/cli"
  },
  {
    title: "管理员",
    kicker: "Slurm / systemd",
    body: "配置单机 Slurm、启动 API/Web 服务、启用登录层 GPU 隔离和维护邮件提醒。",
    to: "/docs/admin-guide/slurm"
  },
  {
    title: "接口与维护",
    kicker: "API / roadmap",
    body: "查看 HTTP API、环境变量、功能状态和后续文档维护规则。",
    to: "/docs/reference/api"
  }
];

const taskLinks = [
  {
    title: "第一次使用",
    body: "安装后先确认 API、GPU 状态和一个最小 Slurm 作业。",
    to: "/docs/getting-started/quickstart"
  },
  {
    title: "提交训练任务",
    body: "选择 GPU、填写 reason、设置预计时长和 Slurm 硬限制。",
    to: "/docs/user-guide/cli#后台作业"
  },
  {
    title: "打开交互 shell",
    body: "进入 tmux 管理的 Slurm GPU shell，并在 Esc 面板里查看 job、日志和提醒。",
    to: "/docs/user-guide/cli#交互式-shell"
  },
  {
    title: "部署服务",
    body: "启动 API/Web 服务，把文档部署到 8000/doc，并确认 Web 入口不再回落到示例页。",
    to: "/docs/admin-guide/services"
  }
];

const commandRows = [
  ["查看状态", "tmesh status --all"],
  ["提交后台作业", "tmesh run --gpus 1 --time 8 --reason \"训练\" -- python train.py"],
  ["交互式 shell", "tmesh bash --gpus 1 --reason \"调试\""],
  ["重新进入会话", "tmesh ls && tmesh open <ID>"],
  ["生成 Web URL", "tmesh web --ttl 24"],
  ["同步文档到 Web", "npm run deploy:docs:web"]
];

const deployChecks = [
  "API 服务监听 4317，Web 代理 /api 和 /health",
  "Docusaurus baseUrl 固定为 /doc/",
  "apps/web/public/doc 来自 npm run deploy:docs:web",
  "Web 顶栏文档按钮跳转到 /doc/"
];

export default function Home(): ReactElement {
  const systemMapUrl = useBaseUrl("/img/tensormesh-system-map.png");

  return (
    <Layout
      title="GPU 使用管理文档"
      description="TensorMesh documentation for users, admins, and maintainers"
    >
      <main className={styles.shell}>
        <section className={styles.pageGrid}>
          <aside className={styles.localToc} aria-label="首页目录">
            <p>TensorMesh</p>
            <a href="#overview">概览</a>
            <a href="#tasks">任务入口</a>
            <a href="#commands">命令速查</a>
            <a href="#roles">角色入口</a>
            <a href="#architecture">系统结构</a>
            <a href="#deploy">部署路径</a>
          </aside>

          <div className={styles.content}>
            <section className={styles.hero} id="overview">
              <p className={styles.eyebrow}>TensorMesh Docs</p>
              <h1>共享 GPU 服务器的使用与运维手册</h1>
              <p className={styles.lead}>
                面向普通用户、管理员和维护者，按当前代码能力重新整理 CLI、TUI、
                Web 门户、Slurm 集成、服务部署、登录隔离和提醒系统。
              </p>
              <div className={styles.actions}>
                <Link className={styles.primaryAction} to="/docs/getting-started/quickstart">
                  快速开始
                </Link>
                <Link className={styles.secondaryAction} to="/docs/user-guide/cli">
                  用户手册
                </Link>
                <Link className={styles.secondaryAction} to="/docs/admin-guide/services">
                  部署说明
                </Link>
                <Link className={styles.secondaryAction} to="/docs/reference/commands">
                  命令速查
                </Link>
              </div>
            </section>

            <section className={styles.taskGrid} id="tasks" aria-label="按任务找文档">
              {taskLinks.map((item) => (
                <Link className={styles.task} to={item.to} key={item.title}>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </Link>
              ))}
            </section>

            <section className={styles.commandTable} id="commands" aria-label="常用命令速查">
              <div className={styles.sectionHeader}>
                <p className={styles.eyebrow}>Command Reference</p>
                <h2>常用命令速查</h2>
                <p>这些命令覆盖日常查看、提交、交互调试、Web 登录和文档部署。</p>
              </div>
              <div className={styles.commandRows}>
                {commandRows.map(([label, command]) => (
                  <div className={styles.commandRow} key={label}>
                    <span>{label}</span>
                    <code>{command}</code>
                  </div>
                ))}
              </div>
              <Link className={styles.inlineLink} to="/docs/reference/commands">
                查看完整命令速查
              </Link>
            </section>

            <section className={styles.entryGrid} id="roles" aria-label="文档入口">
              {entryPoints.map((item) => (
                <Link className={styles.entry} to={item.to} key={item.title}>
                  <span>{item.kicker}</span>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </Link>
              ))}
            </section>

            <section className={styles.mapSection} id="architecture" aria-label="系统结构">
              <div className={styles.sectionHeader}>
                <p className={styles.eyebrow}>Architecture</p>
                <h2>文档按真实系统边界组织</h2>
                <p>
                  TensorMesh 不替代 Slurm。它把 GPU 状态采集、作业封装、Web 查看、提醒和导出组合成更容易执行的共享服务器工作流。
                </p>
              </div>
              <img src={systemMapUrl} alt="TensorMesh system map" />
            </section>

            <section className={styles.deployNote} id="deploy">
              <h2>局域网部署路径</h2>
              <p>
                文档站构建为 <code>/doc/</code> 子路径，适合和 Web 控制台一起部署在
                <code>http://server:8000/doc/</code> 下。
              </p>
              <ul>
                {deployChecks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
        </section>
      </main>
    </Layout>
  );
}
