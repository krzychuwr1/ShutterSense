import "./styles/app.css";
import "./styles/lens.css";
import "./styles/landing.css";
import { startDemo } from "./demo.ts";
import { startGlasses } from "./glasses.ts";
import { startLanding } from "./landing.ts";

const root = document.getElementById("app")!;
let [section] = location.pathname.split("/").filter(Boolean);

/** A small, square display: the glasses' 600 x 600 lens rather than a phone or a desktop window. */
const lensSized = (w: number, h: number) => w > 0 && w <= 720 && h <= 720 && Math.abs(w - h) <= 48;
const onGlasses = () => lensSized(screen.width, screen.height) || ("install" in navigator && lensSized(innerWidth, innerHeight));

// Whatever URL the glasses opened, they go straight to pairing.
if (section !== "g" && onGlasses()) {
  history.replaceState(null, "", "/g");
  section = "g";
}

if (section === "g") startGlasses(root);
else if (section === "try") startDemo(root);
else startLanding(root);
