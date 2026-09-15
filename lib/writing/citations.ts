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
  {
    id: "didion-white",
    author: "Joan Didion",
    title: "The White Album",
    year: "1979",
    publisher: "Simon & Schuster",
    tags: ["writing", "essay", "nonfiction"],
  },
  {
    id: "king-on-writing",
    author: "Stephen King",
    title: "On Writing",
    year: "2000",
    publisher: "Scribner",
    tags: ["writing", "memoir", "craft"],
  },
  {
    id: "pinker-style",
    author: "Steven Pinker",
    title: "The Sense of Style",
    year: "2014",
    publisher: "Viking",
    tags: ["writing", "style", "grammar"],
  },
  {
    id: "williams-style",
    author: "Joseph M. Williams and Joseph Bizup",
    title: "Style: Lessons in Clarity and Grace",
    year: "2016",
    publisher: "Pearson",
    tags: ["writing", "style", "clarity"],
  },
];

export function searchCitations(query: string, limit = 5): CatalogWork[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  if (!tokens.length) return CITATION_CATALOG.slice(0, limit);
  return CITATION_CATALOG.map((work) => {
    const hay = `${work.author} ${work.title} ${work.tags.join(" ")} ${work.year} ${work.publisher ?? ""}`.toLowerCase();
    const score = tokens.reduce((sum, token) => {
      if (hay.includes(token)) return sum + 2;
      if (hay.split(/\s+/).some((word) => word.startsWith(token))) return sum + 1;
      return sum;
    }, 0);
    return { work, score };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.work);
}

export function formatInlineCite(work: CatalogWork) {
  const authors = work.author.split(/\s+and\s+/i).map((author) => author.trim()).filter(Boolean);
  const surnames = authors.map((author) => {
    const words = author.replace(/[,]+/g, "").split(/\s+/).filter(Boolean);
    return words.findLast((word) => !/^(jr\.?|sr\.?|i{1,3}|iv)$/i.test(word)) ?? words[words.length - 1] ?? author;
  });
  const label = surnames.length > 2
    ? `${surnames[0]} et al.`
    : surnames.length === 2
      ? `${surnames[0]} & ${surnames[1]}`
      : surnames[0] ?? work.author;
  return `(${label}, ${work.year})`;
}

export function formatBibliography(work: CatalogWork) {
  return [work.author, work.title, work.publisher, work.year, work.url].filter(Boolean).join(". ") + ".";
}
