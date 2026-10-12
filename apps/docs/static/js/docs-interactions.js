(function () {
  var enhancedAttribute = "data-tensormesh-copy-ready";
  var observerStarted = false;
  var refreshTimer = 0;

  function setTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    document.documentElement.setAttribute("data-theme-choice", mode);
    try {
      window.localStorage.setItem("theme", mode);
    } catch (_error) {}
    updateThemeButtons();
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  }

  function updateThemeButtons() {
    var isDark = currentTheme() === "dark";
    var label = isDark ? "切换到浅色主题" : "切换到深色主题";
    var html = '<span aria-hidden="true">' + (isDark ? "L" : "D") + "</span>" + (isDark ? "Light" : "Dark");
    document.querySelectorAll(".tm-theme-toggle").forEach(function (button) {
      button.disabled = false;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      if (button.innerHTML !== html) {
        button.innerHTML = html;
      }
    });
  }

  function bindThemeButtons() {
    updateThemeButtons();
    document.querySelectorAll(".tm-theme-toggle").forEach(function (button) {
      if (button.getAttribute("data-tensormesh-theme-ready") === "true") return;
      button.setAttribute("data-tensormesh-theme-ready", "true");
      button.addEventListener("click", function () {
        setTheme(currentTheme() === "dark" ? "light" : "dark");
      });
    });
  }

  function codeText(container) {
    var code = container.querySelector("code");
    if (!code) return "";

    var tokenLines = code.querySelectorAll(".token-line");
    if (tokenLines.length > 0) {
      return Array.prototype.map
        .call(tokenLines, function (line) {
          return line.textContent || "";
        })
        .join("\n")
        .replace(/\n$/, "");
    }

    return (code.innerText || code.textContent || "").replace(/\n$/, "");
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function enhanceCodeBlocks() {
    document.querySelectorAll(".theme-code-block, .commandPanel_AXP8, pre").forEach(function (container) {
      if (container.tagName === "PRE" && container.closest(".theme-code-block")) return;
      if (container.tagName === "PRE" && (!container.firstElementChild || container.firstElementChild.tagName !== "CODE")) return;
      if (container.getAttribute(enhancedAttribute) === "true") return;

      var text = codeText(container);
      if (!text.trim()) return;

      container.setAttribute(enhancedAttribute, "true");
      container.classList.add("tm-copyable-code");

      var button = document.createElement("button");
      button.type = "button";
      button.className = "tm-copy-code-button";
      button.setAttribute("aria-label", "复制代码到剪贴板");
      button.setAttribute("title", "复制代码");
      button.textContent = "复制";
      button.addEventListener("click", function () {
        copyText(text)
          .then(function () {
            button.textContent = "已复制";
            button.classList.add("tm-copy-code-button--copied");
          })
          .catch(function () {
            button.textContent = "失败";
          })
          .finally(function () {
            window.setTimeout(function () {
              button.textContent = "复制";
              button.classList.remove("tm-copy-code-button--copied");
            }, 1200);
          });
      });

      container.appendChild(button);
    });
  }

  function refreshInteractions() {
    bindThemeButtons();
    enhanceCodeBlocks();
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshInteractions, 80);
  }

  function startObserver() {
    if (observerStarted || !document.body || !window.MutationObserver) return;
    observerStarted = true;
    new MutationObserver(function (mutations) {
      for (var index = 0; index < mutations.length; index += 1) {
        if (mutations[index].addedNodes.length > 0) {
          scheduleRefresh();
          break;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    refreshInteractions();
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  window.addEventListener("load", boot);
  window.addEventListener("pageshow", boot);
  window.addEventListener("popstate", function () {
    window.setTimeout(boot, 0);
  });
})();
