/**
 * Extension Control — configuration.
 *
 * The controlled add-ons read `<slug>/control.json` from the `updates` branch
 * of this repo (see any extension's background/control.js). This add-on is
 * just an editor for those files: it reads them through the GitHub contents
 * API and writes them back with a personal access token the admin pastes once.
 *
 * Adding a controlled add-on = one more entry in EXTS (its slug must match the
 * matrix entry in .github/workflows/sign-and-publish.yml).
 */
export const Config = {
  DEBUG: false,

  // Repo whose `updates` branch carries the control files.
  OWNER: "sparrrow1011",
  REPO: "LTL_Viewer",
  BRANCH: "updates",

  // Controlled add-ons (slug → display name). Order = order of the cards.
  EXTS: [
    { slug: "lobby-sweeper", name: "Lobby Sweeper" },
    { slug: "ms-viewer", name: "MS Viewer" },
    { slug: "hc-calculator", name: "HC Calculator" },
    { slug: "all-runs", name: "All Runs" },
    { slug: "pg-tms-viewer", name: "P&G TMS Viewer" },
  ],

  // Where the add-ons report their install roster (usage.js in each of them).
  SP_ORIGIN: "https://amazongbr.sharepoint.com",
  SP_SITE_PATH: "/sites/AmazonFreightOperations",
  ROSTER_LIST: "Extension_Installs",

  // The older GitHub Pages admin page — kept as a fallback link.
  CONTROL_PAGE: "https://sparrrow1011.github.io/LTL_Viewer/",
};
