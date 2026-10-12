import type {Config} from "@docusaurus/types";
import type {Plugin} from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import {themes} from "prism-react-renderer";

function generatedRegistryWebpackFix(): Plugin {
  return {
    name: "generated-registry-webpack-fix",
    configureWebpack(_config, isServer) {
      return {
        module: {
          rules: [
            {
              test: isServer
                ? /[\\/]\.docusaurus[\\/](client-modules|registry)\.js$/
                : /[\\/]\.docusaurus[\\/]client-modules\.js$/,
              type: "javascript/auto"
            }
          ]
        }
      };
    }
  };
}

const config: Config = {
  title: "TensorMesh",
  tagline: "共享研究服务器的 GPU 使用管理平台",
  url: "https://tensormesh.local",
  baseUrl: "/doc/",
  organizationName: "tensormesh",
  projectName: "tensormesh",
  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn"
    }
  },
  i18n: {
    defaultLocale: "zh-CN",
    locales: ["zh-CN"]
  },
  clientModules: ["./src/client/codeBlockCopy.ts"],
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "docs"
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css"
        }
      } satisfies Preset.Options
    ]
  ],
  plugins: [generatedRegistryWebpackFix],
  scripts: [
    {
      src: "/doc/js/docs-interactions.js",
      defer: true
    }
  ],
  themeConfig: {
    image: "img/tensormesh-system-map.png",
    colorMode: {
      defaultMode: "light",
      disableSwitch: true,
      respectPrefersColorScheme: false
    },
    navbar: {
      title: "TensorMesh",
      items: [
        {
          type: "docSidebar",
          sidebarId: "mainSidebar",
          position: "left",
          label: "目录"
        },
        {
          to: "/docs/reference/api",
          label: "API",
          position: "left"
        },
        {
          to: "/docs/admin-guide/services",
          label: "部署",
          position: "right"
        }
      ]
    },
    footer: {
      style: "light",
      links: [
        {
          title: "文档",
          items: [
            {label: "快速开始", to: "/docs/getting-started/quickstart"},
            {label: "CLI", to: "/docs/user-guide/cli"},
            {label: "管理员部署", to: "/docs/admin-guide/services"}
          ]
        },
        {
          title: "项目",
          items: [
            {label: "API 参考", to: "/docs/reference/api"},
            {label: "功能状态", to: "/docs/reference/feature-status"}
          ]
        }
      ],
      copyright: `Copyright © ${new Date().getFullYear()} TensorMesh.`
    },
    prism: {
      theme: themes.github,
      darkTheme: themes.dracula
    }
  } satisfies Preset.ThemeConfig
};

export default config;
