import type {ReactElement} from "react";

type Props = {
  className?: string;
};

export default function NavbarColorModeToggle({className}: Props): ReactElement {
  return (
    <button
      type="button"
      className={["tm-theme-toggle", className].filter(Boolean).join(" ")}
      aria-label="切换到深色主题"
      title="切换到深色主题"
    >
      <span aria-hidden="true">D</span>
      Dark
    </button>
  );
}
