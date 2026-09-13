export type CatalogWork = {
  id: string;
  author: string;
  title: string;
  year: string;
  publisher?: string;
  url?: string;
  tags: string[];
};

export const CITATION_CATALOG: CatalogWork[] = [
  {
    id: "orwell-politics",
    author: "George Orwell",
    title: "Politics and the English Language",
    year: "1946",
    publisher: "Horizon",
    tags: ["writing", "style", "rhetoric"],
  },
  {
    id: "strunk-white",
    author: "William Strunk Jr. and E. B. White",
    title: "The Elements of Style",
    year: "1959",
    publisher: "Macmillan",
    tags: ["writing", "grammar", "style"],
  },
  {
    id: "zinsser",
    author: "William Zinsser",
    title: "On Writing Well",
    year: "1976",
    publisher: "Harper",
    tags: ["writing", "nonfiction"],
  },
  {
    id: "tufte",
    author: "Edward R. Tufte",
    title: "The Visual Display of Quantitative Information",
    year: "1983",
    publisher: "Graphics Press",
    tags: ["data", "design"],
  },
  {
    id: "kahneman",
    author: "Daniel Kahneman",
    title: "Thinking, Fast and Slow",
    year: "2011",
    publisher: "Farrar, Straus and Giroux",
    tags: ["psychology", "decision"],
  },
  {
    id: "lamott",
    author: "Anne Lamott",
    title: "Bird by Bird",
    year: "1994",
    publisher: "Pantheon",
    tags: ["writing", "fiction", "process"],
  },
  {
    id: "mla",
    author: "Modern Language Association",
    title: "MLA Handbook",
    year: "2021",
    publisher: "MLA",
    tags: ["citation", "mla", "school"],
  },
  {
    id: "apa",
    author: "American Psychological Association",
    title: "Publication Manual of the American Psychological Association",
    year: "2020",
    publisher: "APA",
    tags: ["citation", "apa"],
  },
  {
    id: "chicago",
    author: "University of Chicago Press",
    title: "The Chicago Manual of Style",
    year: "2017",
    publisher: "University of Chicago Press",
    tags: ["citation", "chicago"],
  },
  {
    id: "federalist",
    author: "Alexander Hamilton, James Madison, and John Jay",
    title: "The Federalist Papers",
    year: "1788",
    tags: ["history", "politics", "public-domain"],
  },
];

export function searchCitations(query: string, limit = 5): CatalogWork[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return CITATION_CATALOG.slice(0, limit);
  return CITATION_CATALOG.map((work) => {
    const hay = `${work.author} ${work.title} ${work.tags.join(" ")} ${work.year}`.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
    return { work, score };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.work);
}

export function formatInlineCite(work: CatalogWork) {
  const last = work.author.split(",")[0].split(" and ")[0].split(" ").slice(-1)[0];
  return `(${last}, ${work.year})`;
}

export function formatBibliography(work: CatalogWork) {
  return [work.author, work.title, work.publisher, work.year, work.url].filter(Boolean).join(". ") + ".";
}
