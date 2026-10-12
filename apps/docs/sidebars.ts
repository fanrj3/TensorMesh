import type {SidebarsConfig} from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  mainSidebar: [
    "intro",
    {
      type: "category",
      label: "开始使用",
      items: [
        "getting-started/overview",
        "getting-started/quickstart"
      ]
    },
    {
      type: "category",
      label: "普通用户",
      items: [
        "user-guide/cli",
        "user-guide/tui",
        "user-guide/web",
        "user-guide/notice",
        "user-guide/ai-agent-skill"
      ]
    },
    {
      type: "category",
      label: "管理员",
      items: [
        "admin-guide/slurm",
        "admin-guide/services",
        "admin-guide/gpu-isolation",
        "admin-guide/share"
      ]
    },
    {
      type: "category",
      label: "参考",
      items: [
        "reference/commands",
        "reference/configuration",
        "reference/api",
        "reference/feature-status"
      ]
    },
    {
      type: "category",
      label: "开发维护",
      items: [
        "development/maintenance"
      ]
    }
  ]
};

export default sidebars;
