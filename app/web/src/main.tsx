import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import "./styles/shell.css";
import "./styles/thread.css";
import "./styles/lists.css";
import "./styles/settings.css";
import "./styles/member.css";
import "./styles/library.css";

createRoot(document.getElementById("root")!).render(<App />);
