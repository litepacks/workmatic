/** @type {import('docboot').DocbootConfig} */
export default {
  title: "Workmatic",
  description: "A persistent, high-performance job queue for Node.js using SQLite",
  docs: "./docs",
  out: "./dist-docs",
  base: "/workmatic/",
  siteUrl: "https://litepacks.github.io/workmatic/",
  repo: "https://github.com/litepacks/workmatic",
  theme: {
    preset: "ocean",
    defaultMode: "system"
  },
  editLink: {
    pattern: "https://github.com/litepacks/workmatic/edit/main/docs/:path"
  },
  sourceLink: {
    pattern: "https://github.com/litepacks/workmatic/blob/main/docs/:path"
  },
  search: {
    fuzzy: 0.2,
    prefix: true,
    maxResults: 10
  }
};
