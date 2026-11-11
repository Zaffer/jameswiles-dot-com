// Builds the site into _site/.
//   blog/*.md   → blog/*.html, poured into _build/post.html
//   index.html  → {{posts}} and {{updated}} filled in
//   blog images → a smaller WebP copy of each PNG and JPEG, which the posts load
//   the rest    → copied as is, except names starting with "_" or "."
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Marked } from 'marked'
import sharp from 'sharp'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '_site')
const SITE = 'https://' + fs.readFileSync(path.join(ROOT, 'CNAME'), 'utf8').trim()
const AUTHOR = 'James K. Wiles'
const DEFAULT_IMAGE = '/blog/images/acorn.png'
const DEFAULT_IMAGE_ALT = "Seven white dots on black: the acorn pattern from Conway's Game of Life"
const MEASURE = 720 // width of the measure table in the templates
const MAX_WIDTH = 2 * MEASURE // an image is never shown wider than the measure; twice that stays sharp on dense screens
const PHONE = 300 // an image inside a line of text keeps its natural size only if it fits the narrowest phone
const UNPUBLISHED = ['node_modules', 'package.json', 'package-lock.json', 'README.md']

const today = new Date().toISOString().slice(0, 10)
const warnings = new Set()

const escapeHtml = text =>
  text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const fill = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (mark, key) => {
    if (!(key in values)) throw new Error(`template has no value for ${mark}`)
    return values[key]
  })

// Commit date of a file: the first commit, or the latest. Null outside git or before the first commit.
function gitDate(file, which) {
  const args = which === 'first' ? ['--diff-filter=A', '--follow'] : ['-1']
  try {
    const out = execFileSync('git', ['log', '--format=%as', ...args, '--', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split('\n').pop() || null
  } catch {
    return null
  }
}

// Every image under blog/, by its address on the site: its size, and the file a post should
// load. A PNG or JPEG is resized to at most MAX_WIDTH and written as WebP twice, lossless and at
// quality 90, and the smaller one is kept: flat charts stay exact, photos shrink to a fraction.
// The original is still published at its own address, for share previews and old links.
async function prepareImages() {
  const images = new Map()
  const files = fs
    .readdirSync(path.join(ROOT, 'blog'), { recursive: true })
    .map(file => file.split(path.sep).join('/'))
    .filter(file => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file) && !/(^|\/)[._]/.test(file))
  let before = 0
  let after = 0
  await Promise.all(
    files.map(async file => {
      const address = '/blog/' + file
      const source = path.join(ROOT, 'blog', file)
      const { width, height } = await sharp(source).metadata()
      const image = { src: address, width, height, shown: width }
      images.set(address, image)
      if (!/\.(png|jpe?g)$/i.test(file)) return
      const webp = address.replace(/\.\w+$/, '.webp')
      if (files.some(other => '/blog/' + other !== address && ('/blog/' + other).replace(/\.(png|jpe?g)$/i, '.webp') === webp)) {
        throw new Error(`blog/${file}: another image would also become ${webp}. Rename one of them.`)
      }
      const resized = () => sharp(source).resize({ width: MAX_WIDTH, withoutEnlargement: true })
      const [lossless, lossy] = await Promise.all([
        resized().webp({ lossless: true, effort: 6 }).toBuffer(),
        resized().webp({ quality: 90, effort: 6 }).toBuffer(),
      ])
      const smaller = lossless.length <= lossy.length ? lossless : lossy
      fs.writeFileSync(path.join(OUT, webp), smaller)
      image.src = webp
      image.shown = Math.min(width, MAX_WIDTH)
      before += fs.statSync(source).size
      after += smaller.length
    }),
  )
  console.log(`${images.size} images, ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB as WebP`)
  return images
}

// With no CSS there is no max-width, so an image wider than the screen would push the page
// sideways. An image narrower than the measure, on a line of its own, sits in its own measure
// table: natural size on a wide screen, shrinking on a narrow one. Everything else, including
// any image whose size is unknown (one on another site), gets width="100%".
function image(post, token, alone) {
  let src = token.href
  let width = null
  if (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
    let address = src.replace(/[?#].*/, '')
    try {
      address = decodeURIComponent(address)
    } catch {} // a stray % in the path: use it as written
    address = path.posix.resolve('/blog', address)
    const known = images.get(address)
    if (known) {
      src = known.src
      width = known.shown
    } else if (!fs.existsSync(path.join(ROOT, address))) {
      warnings.add(`${post}: image not found: ${token.href}`)
    }
  }
  const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
  const tag = `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title}`
  const small = width !== null && width < MEASURE
  if (!alone) return small && width <= PHONE ? `${tag}>` : `${tag} width="100%">`
  if (!small) return `<p>${tag} width="100%"></p>\n`
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td width="${width}">${tag} width="100%"></td><td></td></tr></table>\n`
}

// With no CSS a word wider than the screen also pushes the page sideways. Long words, which are
// mostly URLs, get <wbr> break points: after / _ = , and before . ? &
const breakLongWords = html =>
  html.replace(/<[^>]*>|[^<\s]{30,}/g, word => (word[0] === '<' ? word : word.replace(/[/_=,]+|(?=[.?].|&amp;)/g, '$&<wbr>')))

function markdown(post) {
  return new Marked({
    renderer: {
      image: token => image(post, token, false),
      // an image on a line of its own
      paragraph: ({ tokens }) => (tokens.length === 1 && tokens[0].type === 'image' ? image(post, tokens[0], true) : false),
      // <pre wrap> wraps long lines, so code cannot push the page sideways either
      code: ({ text }) => `<pre wrap><code>${escapeHtml(text)}</code></pre>\n`,
    },
  })
}

// Optional "key: value" lines between two --- lines at the top of a note.
function frontMatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(source)
  if (!match) return [{}, source]
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^(\w+):\s*(.*?)\s*$/.exec(line)
    if (pair) meta[pair[1]] = pair[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return [meta, source.slice(match[0].length)]
}

function readPost(filename) {
  const file = path.join('blog', filename)
  const name = path.basename(filename, '.md')
  const slug = name.trim().replace(/\s+/g, '-')
  const [meta, body] = frontMatter(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  const marked = markdown(file)
  const tokens = marked.lexer(body)

  // the visible text of a heading or paragraph, markup removed
  const plain = token =>
    marked.Parser.parseInline(token.tokens, marked.defaults)
      .replace(/<[^>]+>/g, '')
      .replace(/&(amp|lt|gt|quot|#39);/g, (entity, code) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[code])
      .replace(/\s+/g, ' ')
      .trim()

  // Title: front matter, else the first "# heading", else the file name.
  const heading = tokens.find(token => token.type === 'heading' && token.depth === 1)
  const title = meta.title || (heading && plain(heading)) || (name.includes(' ') ? name : name.replaceAll('-', ' '))

  // Byline: an italic line straight after the heading that carries a date, "*Name | 2025-01-31*".
  const paragraphs = tokens.filter(token => token.type === 'paragraph')
  const byline = paragraphs[0] && /^[*_][^\n]*?(\d{4}-\d{2}-\d{2})/.exec(paragraphs[0].raw)

  // Date: front matter, else the byline, else the day the file was first committed, else today.
  const date = /\d{4}-\d{2}-\d{2}/.exec(meta.date ?? '')?.[0] ?? byline?.[1] ?? gitDate(file, 'first') ?? today

  // Description: front matter, else the first paragraph of words.
  let description = meta.description
  if (!description) {
    const first = paragraphs.slice(byline ? 1 : 0).map(plain).find(Boolean) ?? title
    description = first.length > 160 ? first.slice(0, 160).replace(/\s+\S*$/, '') + '…' : first
  }

  let content = breakLongWords(marked.parser(tokens))
    .replaceAll('<table>', '<table border="1" cellpadding="6" cellspacing="0">') // no CSS: tables need their own lines
    .trim()
  const stamp = `<time datetime="${date}">${date}</time>`
  if (!heading) content = `<h1>${escapeHtml(title)}</h1>\n${content}`
  if (byline) content = content.replace(byline[1], stamp)
  else content = content.replace('</h1>', `</h1>\n<p><em>${AUTHOR} | ${stamp}</em></p>`)

  // Share image: front matter, else the default. Previews load the original, not the WebP.
  let shareAddress = meta.image || DEFAULT_IMAGE
  if (!images.has(shareAddress)) {
    warnings.add(`${file}: share image not found: ${shareAddress}`)
    shareAddress = DEFAULT_IMAGE
  }
  const share = images.get(shareAddress)

  // Its description: the alt text where the post shows the same image, else the title.
  let shareAlt = shareAddress === DEFAULT_IMAGE ? DEFAULT_IMAGE_ALT : title
  marked.walkTokens(tokens, token => {
    if (token.type === 'image' && token.text && path.posix.resolve('/blog', token.href) === shareAddress) shareAlt = token.text
  })

  return {
    file,
    slug,
    title,
    date,
    description,
    content,
    image: SITE + shareAddress,
    imageWidth: share.width,
    imageHeight: share.height,
    imageAlt: shareAlt,
    path: `/blog/${encodeURI(slug)}.html`,
    source: `/blog/${encodeURI(name)}.md`,
  }
}

// ── build ──

fs.rmSync(OUT, { recursive: true, force: true })
for (const entry of fs.readdirSync(ROOT)) {
  if (/^[._]/.test(entry) || UNPUBLISHED.includes(entry)) continue
  fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), {
    recursive: true,
    filter: source => !/^[._]/.test(path.basename(source)),
  })
}

const images = await prepareImages()

const posts = fs
  .readdirSync(path.join(ROOT, 'blog'))
  .filter(filename => filename.endsWith('.md') && !/^[._]/.test(filename))
  .map(readPost)
  .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))

const template = fs.readFileSync(path.join(ROOT, '_build/post.html'), 'utf8')
const seen = new Map()
for (const post of posts) {
  if (seen.has(post.slug)) throw new Error(`${post.file} and ${seen.get(post.slug)} would both become blog/${post.slug}.html`)
  seen.set(post.slug, post.file)
  const html = fill(template, {
    title: escapeHtml(post.title),
    description: escapeHtml(post.description),
    url: SITE + post.path,
    source: post.source,
    image: post.image,
    imageWidth: post.imageWidth,
    imageHeight: post.imageHeight,
    imageAlt: escapeHtml(post.imageAlt),
    date: post.date,
    content: post.content,
  })
  fs.writeFileSync(path.join(OUT, 'blog', post.slug + '.html'), html)
  console.log(`${post.date}  ${(Buffer.byteLength(html) / 1000).toFixed(1).padStart(5)} kB  blog/${post.slug}.html`)
}

const rows = posts.map(post => `<time datetime="${post.date}">${post.date}</time> <a href="${post.path}">${escapeHtml(post.title)}</a>`)
const home = fill(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), { posts: rows.join('<br>\n'), updated: today })
fs.writeFileSync(path.join(OUT, 'index.html'), home)

const urls = [
  `<url><loc>${SITE}/</loc><lastmod>${today}</lastmod></url>`,
  ...posts.map(post => `<url><loc>${SITE}${post.path}</loc><lastmod>${gitDate(post.file, 'latest') ?? post.date}</lastmod></url>`),
]
fs.writeFileSync(
  path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
)

console.log(`${posts.length} posts → ${path.relative(ROOT, OUT)}/`)
for (const warning of warnings) console.warn(`warning: ${warning}`)
