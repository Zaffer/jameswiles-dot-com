# jameswiles.com

Built in [plain-site](https://github.com/Zaffer/plain-site): HTML only, no CSS.

## Add a blog post

Put a Markdown file in [blog/](blog/). On GitHub: **Add file → Create new file**, name it
`blog/My-Title.md`, paste the note, commit. A minute later it is a page at
`/blog/My-Title.html` and a row in the blog list on the home page.

Nothing else is required. The build works these out:

| | Taken from, in order |
|---|---|
| Title | `title:` in front matter, the first `# heading`, the file name |
| Date | `date:` in front matter, a byline like `*James K. Wiles \| 2025-01-31*` under the heading, the day the file was first committed |
| Description | `description:` in front matter, the first paragraph |
| Share image | `image:` in front matter, the acorn |

Front matter is optional: `key: value` lines between two `---` lines at the top of the file.

- Spaces in a file name become hyphens in the URL.
- A file whose name starts with `_` is a draft and is not published.
- Images go in [blog/images/](blog/images/) and are written as `![alt](/blog/images/name.png)`.
- The Markdown file is published too, next to the page.

## How it works

Every push to `main` runs [.github/workflows/site.yml](.github/workflows/site.yml), which runs
[_build/build.mjs](_build/build.mjs) and deploys the `_site/` folder it makes to GitHub Pages.

```
index.html           home page; the build fills in the post list and the date
blog/*.md            posts
_build/post.html     the page every post is poured into
_build/build.mjs     the build: Markdown → HTML, sitemap.xml, copies everything else
```

Names that start with `_` or `.` are never published.

Preview on this machine: `npm install` once, then `npm run preview` and open
<http://localhost:8000>.
