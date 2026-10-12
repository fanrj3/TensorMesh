import type {ClientModule} from "@docusaurus/types";

const enhancedAttribute = "data-tensormesh-copy-ready";

function getCodeText(container: HTMLElement): string {
  const code = container.querySelector("code");
  if (!code) return "";

  const tokenLines = code.querySelectorAll<HTMLElement>(".token-line");
  if (tokenLines.length > 0) {
    return Array.from(tokenLines, (line) => line.textContent ?? "")
      .join("\n")
      .replace(/\n$/, "");
  }

  return (code.innerText || code.textContent || "").replace(/\n$/, "");
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP LAN pages may expose clipboard APIs but reject writeText().
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function enhanceCodeBlocks(): void {
  document
    .querySelectorAll<HTMLElement>(".theme-code-block, .commandPanel_AXP8, pre")
    .forEach((container) => {
      if (container.tagName === "PRE" && container.closest(".theme-code-block")) return;
      if (container.tagName === "PRE" && container.firstElementChild?.tagName !== "CODE") return;
      if (container.hasAttribute(enhancedAttribute)) return;
      const text = getCodeText(container);
      if (!text.trim()) return;

      container.setAttribute(enhancedAttribute, "true");
      container.classList.add("tm-copyable-code");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "tm-copy-code-button";
      button.setAttribute("aria-label", "复制代码到剪贴板");
      button.title = "复制代码";
      button.textContent = "复制";
      button.addEventListener("click", async () => {
        try {
          await copyText(text);
          button.textContent = "已复制";
          button.classList.add("tm-copy-code-button--copied");
          window.setTimeout(() => {
            button.textContent = "复制";
            button.classList.remove("tm-copy-code-button--copied");
          }, 1200);
        } catch {
          button.textContent = "失败";
          window.setTimeout(() => {
            button.textContent = "复制";
          }, 1200);
        }
      });

      container.append(button);
    });
}

const clientModule: ClientModule = {
  onRouteDidUpdate() {
    enhanceCodeBlocks();
  }
};

export default clientModule;
