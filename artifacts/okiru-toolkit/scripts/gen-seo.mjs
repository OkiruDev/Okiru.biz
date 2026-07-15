/*
 * SEO static page generator for the Okiru AI Tool Advisor.
 *
 * Reads the `tools` array (single source of truth) out of public/toolkit.html
 * and emits crawlable, self-contained static HTML pages:
 *   - /tools/<slug>.html        one page per tool (canonical, indexable)
 *   - /category/<slug>.html     one page per category
 *   - /tools.html               hub linking to every tool + category
 *   - /blog/<slug>.html         one page per blog post (canonical, indexable)
 *   - /blog/          blog listing page
 *   - /sitemap.xml              regenerated with real, resolvable URLs
 *
 * Also patches public/toolkit.html directly:
 *   - Injects static WebSite/Organization/ItemList JSON-LD into <script id="seo-jsonld-base">
 *   - Injects static crawlable directory links into <div id="td-categories">
 *
 * Run: pnpm --filter @workspace/okiru-toolkit run gen:seo
 * Also runs automatically before `vite build`.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");
const ORIGIN = "https://okiru.biz";
const APP = "/toolkit/"; // interactive app entry (deep-linkable via ?tool=)
const TODAY = new Date().toISOString().slice(0, 10);

/* ---------- extract the tools array ---------- */
function loadTools() {
  const html = readFileSync(resolve(PUBLIC, "toolkit", "index.html"), "utf8");
  const m = html.match(/\/\*__TOOLS_DATA_START__\*\/([\s\S]*?)\/\*__TOOLS_DATA_END__\*\//);
  if (!m) throw new Error("Could not find TOOLS data markers in toolkit.html");
  const body = m[1].replace(/^\s*const\s+tools\s*=/, "return ");
  // eslint-disable-next-line no-new-func
  const tools = Function(body)();
  if (!Array.isArray(tools) || !tools.length) throw new Error("tools array empty");
  return tools;
}

/* ---------- extract TOOL_BENEFITS ---------- */
function loadBenefits() {
  const html = readFileSync(resolve(PUBLIC, "toolkit", "index.html"), "utf8");
  const m = html.match(/\/\*__TOOL_BENEFITS_START__\*\/([\s\S]*?)\/\*__TOOL_BENEFITS_END__\*\//);
  if (!m) return {};
  const body = m[1].replace(/^\s*const\s+TOOL_BENEFITS\s*=/, "return ");
  try {
    // eslint-disable-next-line no-new-func
    return Function(body)() || {};
  } catch {
    return {};
  }
}

/* ---------- extract BLOG_POSTS ---------- */
function loadBlogPosts() {
  const html = readFileSync(resolve(PUBLIC, "toolkit", "index.html"), "utf8");
  const m = html.match(/\/\*__BLOG_POSTS_START__\*\/([\s\S]*?)\/\*__BLOG_POSTS_END__\*\//);
  if (!m) {
    console.warn("[gen-seo] BLOG_POSTS markers not found — skipping blog generation");
    return [];
  }
  const body = m[1].replace(/^\s*const\s+BLOG_POSTS\s*=/, "return ");
  try {
    // eslint-disable-next-line no-new-func
    const posts = Function(body)();
    return Array.isArray(posts) ? posts : [];
  } catch (e) {
    console.warn("[gen-seo] Could not parse BLOG_POSTS:", e.message);
    return [];
  }
}

/* ---------- helpers ---------- */
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slugify = (s = "") =>
  String(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/·/g, "-")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tool";

// param the SPA expects: encodeURIComponent(name).replace(/%20/g,"+")
const appParam = (name) => encodeURIComponent(name).replace(/%20/g, "+");
const deepLink = (name) => `${APP}?tool=${appParam(name)}`;

const PRICE_NOTE = { Free: "Free", Freemium: "Free plan available", Paid: "Paid" };
const REL_NOTE = { High: "High reliability", Medium: "Medium reliability", Low: "Emerging" };

/* ---------- shared chrome ---------- */
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060110;--bg2:#0c0820;--cyan:#7ee8fa;--purple:#c840fb;--line:rgba(255,255,255,.1);--g:rgba(255,255,255,.62);--g2:rgba(255,255,255,.42)}
html{scroll-behavior:smooth}
body{font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:#eef2f7;line-height:1.7;font-size:16px;-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 20% 10%,rgba(126,232,250,.07),transparent 60%),radial-gradient(ellipse 50% 40% at 85% 80%,rgba(200,64,251,.06),transparent 55%);pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:1040px;margin:0 auto;padding:0 24px}
nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;background:rgba(6,1,16,.82);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff;font-weight:700;letter-spacing:.04em}
.logo img{height:26px;width:auto;display:block}
.nav-links{display:flex;gap:18px;flex-wrap:wrap}
.nav-links a{color:var(--g);text-decoration:none;font-size:14px;font-weight:500}
.nav-links a:hover{color:var(--cyan)}
.crumbs{font-size:13px;color:var(--g2);margin:28px 0 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.crumbs a{color:var(--g);text-decoration:none}
.crumbs a:hover{color:var(--cyan)}
h1{font-size:clamp(28px,5vw,44px);font-weight:800;line-height:1.12;margin:14px 0 16px;letter-spacing:-.01em}
.lede{font-size:18px;color:var(--g);max-width:680px;margin-bottom:24px}
.badges{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:26px}
.badge{font-size:12.5px;font-weight:600;letter-spacing:.03em;padding:6px 13px;border-radius:999px;border:1px solid var(--line);color:#dfe7ef;background:#100b1a;text-decoration:none}
a.badge:hover{border-color:rgba(126,232,250,.5);color:var(--cyan)}
.badge.cyan{color:var(--cyan);border-color:rgba(126,232,250,.4);background:#101323}
.badge.purple{color:var(--purple);border-color:rgba(200,64,251,.4);background:#160623}
.cta-row{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 40px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:13px 26px;border-radius:11px;font-weight:700;font-size:14.5px;text-decoration:none;transition:transform .15s,background .2s}
.btn-primary{background:linear-gradient(135deg,#7ee8fa,#c840fb);color:#08020f}
.btn-primary:hover{transform:translateY(-2px)}
.btn-ghost{border:1px solid var(--line);color:#eef2f7}
.btn-ghost:hover{border-color:rgba(126,232,250,.5);color:var(--cyan)}
section{margin:48px 0}
h2{font-size:22px;font-weight:700;margin-bottom:18px;letter-spacing:-.01em}
p{color:var(--g);margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.card{display:block;text-decoration:none;color:inherit;background:#0d0917;border:1px solid var(--line);border-radius:16px;padding:20px;transition:transform .18s,border-color .2s}
.card:hover{transform:translateY(-3px);border-color:rgba(126,232,250,.4)}
.card-name{font-size:16px;font-weight:700;color:#fff;margin-bottom:6px}
.card-meta{font-size:12px;color:var(--cyan);font-weight:600;letter-spacing:.03em;margin-bottom:8px}
.card-desc{font-size:13.5px;color:var(--g);line-height:1.6}
.cat-block{margin-bottom:34px}
.cat-block h2 a{color:#fff;text-decoration:none}
.cat-block h2 a:hover{color:var(--cyan)}
.cat-count{font-size:13px;font-weight:500;color:var(--g2);margin-left:8px}
.taglist{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 26px}
.tag{font-size:12px;color:var(--g);background:#100b1a;border:1px solid var(--line);border-radius:999px;padding:4px 11px}
.linklist{display:flex;flex-wrap:wrap;gap:10px 18px}
.linklist a{color:var(--g);text-decoration:none;font-size:14.5px}
.linklist a:hover{color:var(--cyan)}
footer{position:relative;z-index:1;border-top:1px solid var(--line);margin-top:64px;padding:34px 24px}
footer .wrap{display:flex;flex-direction:column;gap:14px}
.foot-links{display:flex;flex-wrap:wrap;gap:8px 20px}
.foot-links a{color:var(--g);text-decoration:none;font-size:13.5px}
.foot-links a:hover{color:var(--cyan)}
.foot-fine{font-size:12.5px;color:var(--g2);line-height:1.7}
@media(max-width:560px){nav{padding:12px 16px}.wrap{padding:0 16px}.nav-links{gap:12px}}
`;

const NAV = `
<nav>
  <a class="logo" href="/"><img src="/okiru-logo-side.png" alt="Okiru" onerror="this.style.display='none'"><span>AI Tool Advisor</span></a>
  <div class="nav-links">
    <a href="/tools/">All Tools</a>
    <a href="${APP}">Advisor</a>
    <a href="/blog/">Blog</a>
  </div>
</nav>`;

const FOOTER = (categories) => `
<footer><div class="wrap">
  <div class="foot-links">
    <a href="/">Home</a>
    <a href="/tools/">All AI Tools</a>
    <a href="/blog/">Blog</a>
    ${categories.map((c) => `<a href="/category/${c.slug}/">${esc(c.name)}</a>`).join("\n    ")}
  </div>
  <div class="foot-fine">
    &copy; ${new Date().getFullYear()} Okiru (Pty) Ltd &middot; Reg. No. 2023/597303/07 &middot;
    19 Ameshoff Street, Braamfontein, Johannesburg &middot; <a href="https://okiru.biz" style="color:var(--cyan)">okiru.biz</a>
  </div>
</div></footer>`;

const GTAG = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-K97KNX2WP4"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-K97KNX2WP4');
</script>`;

const TIKTOK_PIXEL = `<!-- TikTok Pixel Code Start -->
<script>
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(
var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script")
;n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
  ttq.load('D95A7FRC77U03DOJ8IT0');
  ttq.page();
}(window, document, 'ttq');
</script>
<!-- TikTok Pixel Code End -->`;

function page({ title, description, canonical, jsonld, body, categories, extraCss = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${GTAG}
${TIKTOK_PIXEL}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ORIGIN}/opengraph.jpg">
<meta property="og:image:alt" content="Okiru AI Tool Advisor">
<meta property="og:site_name" content="Okiru AI Tool Advisor">
<meta property="og:locale" content="en_ZA">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}/opengraph.jpg">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}${extraCss}</style>
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ""}
</head>
<body>
${NAV}
<main class="wrap">
${body}
</main>
${FOOTER(categories)}
<script src="https://okiru-api-production.up.railway.app/api/widget/widget.js" data-color="#7c5cff" async></script>
</body>
</html>`;
}

/* ---------- additional CSS for richer sections ---------- */
const EXTRA_CSS = `
.pros-cons{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
@media(max-width:600px){.pros-cons{grid-template-columns:1fr}}
.pc-box{background:#0d0917;border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.pc-box h3{font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px}
.pc-box.pros h3{color:#6ee7b7}
.pc-box.cons h3{color:#f87171}
.pc-box ul{list-style:none;display:flex;flex-direction:column;gap:8px}
.pc-box ul li{font-size:14px;color:var(--g);padding-left:18px;position:relative}
.pc-box.pros ul li::before{content:'✓';position:absolute;left:0;color:#6ee7b7;font-weight:700}
.pc-box.cons ul li::before{content:'✗';position:absolute;left:0;color:#f87171;font-weight:700}
.benefit-list{display:flex;flex-direction:column;gap:10px;margin-top:8px}
.benefit-item{display:flex;gap:12px;align-items:flex-start;font-size:14.5px;color:var(--g)}
.benefit-icon{flex-shrink:0;width:20px;height:20px;background:linear-gradient(135deg,#7ee8fa,#c840fb);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;color:#08020f;font-weight:800;margin-top:2px}
.bestfor-list{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
.bestfor-pill{font-size:13px;color:var(--cyan);background:#101323;border:1px solid rgba(126,232,250,.3);border-radius:999px;padding:5px 14px;font-weight:600}
.pricing-box{background:#0d0917;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-top:8px}
.pricing-box p{margin:0;font-size:14.5px;color:var(--g)}
.faq-list{display:flex;flex-direction:column;gap:0;margin-top:8px;border:1px solid var(--line);border-radius:14px;overflow:hidden}
details.faq-item{border-bottom:1px solid var(--line)}
details.faq-item:last-child{border-bottom:none}
details.faq-item summary{cursor:pointer;padding:16px 20px;font-size:14.5px;font-weight:600;color:#eef2f7;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;user-select:none}
details.faq-item summary::-webkit-details-marker{display:none}
details.faq-item summary::after{content:'+';font-size:18px;color:var(--cyan);flex-shrink:0;transition:transform .2s}
details.faq-item[open] summary::after{transform:rotate(45deg)}
details.faq-item summary:hover{background:#0d0917}
.faq-answer{padding:0 20px 16px;font-size:14px;color:var(--g);line-height:1.7}
`;

/* ---------- blog-specific CSS ---------- */
const BLOG_CSS = `
.blog-post-header{margin:28px 0 32px}
.blog-post-eyebrow{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.blog-tag-pill{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:5px 13px;border-radius:999px;background:#121827;border:1px solid rgba(126,232,250,.35);color:var(--cyan)}
.blog-post-meta{font-size:13.5px;color:var(--g2);margin-bottom:10px}
.blog-post-body{line-height:1.8;color:rgba(255,255,255,.82);font-size:16.5px}
.blog-post-body h3{font-size:20px;font-weight:700;color:#eef2f7;margin:36px 0 14px;letter-spacing:-.01em}
.blog-post-body p{color:rgba(255,255,255,.8);margin-bottom:18px}
.blog-post-body ul,.blog-post-body ol{padding-left:24px;margin-bottom:18px;color:rgba(255,255,255,.78)}
.blog-post-body li{margin-bottom:8px;line-height:1.7}
.blog-post-body blockquote{border-left:3px solid var(--cyan);padding:14px 20px;background:#0c0d1c;border-radius:0 8px 8px 0;margin:28px 0;font-style:italic;color:rgba(255,255,255,.9)}
.blog-post-body strong{color:#eef2f7;font-weight:700}
.blog-post-body em{color:rgba(255,255,255,.85);font-style:italic}
.blog-post-cover{width:100%;border-radius:16px;margin:24px 0 32px;object-fit:cover;max-height:420px;border:1px solid var(--line)}
.blog-keywords{display:flex;flex-wrap:wrap;gap:8px;margin:40px 0 0;padding-top:24px;border-top:1px solid var(--line)}
.blog-keyword{font-size:12px;background:#100b1a;border:1px solid var(--line);border-radius:999px;padding:4px 12px;color:var(--g2)}
.blog-nav{display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;margin:48px 0 0;padding-top:24px;border-top:1px solid var(--line)}
.blog-nav a{font-size:14px;color:var(--cyan);text-decoration:none;font-weight:600}
.blog-nav a:hover{text-decoration:underline}
.blog-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin-top:32px}
.blog-card{display:block;text-decoration:none;color:inherit;background:#0d0917;border:1px solid var(--line);border-radius:16px;padding:24px;transition:transform .18s,border-color .2s;position:relative;overflow:hidden}
.blog-card-cover{margin:-24px -24px 18px;height:160px;background-size:cover;background-position:center;border-radius:15px 15px 0 0;border-bottom:1px solid var(--line)}
.blog-card:hover{transform:translateY(-3px);border-color:rgba(126,232,250,.4)}
.blog-card-bar{position:absolute;top:0;left:0;width:3px;height:100%;border-radius:3px 0 0 3px;opacity:0.6}
.blog-card-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 11px;border-radius:999px;margin-bottom:10px}
.blog-card-date{font-size:12px;color:var(--g2);margin-bottom:8px}
.blog-card-title{font-size:17px;font-weight:700;color:#eef2f7;line-height:1.35;margin-bottom:10px}
.blog-card-excerpt{font-size:13.5px;color:var(--g);line-height:1.6;margin-bottom:16px}
.blog-card-footer{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--g2)}
.blog-card-arrow{color:var(--cyan);font-size:16px}
`;

/* ---------- tool page builder ---------- */
function toolPage(t, categories, byCat, benefits) {
  const cat = categories.find((c) => c.name === t.cat);
  const canonical = `${ORIGIN}/tools/${t.slug}/`;
  const b = benefits[t.name] || null;

  const title = `${t.name} — Review, Pricing & Alternatives | Okiru AI Tool Advisor`;
  const description = `${t.name}: ${t.desc} ${REL_NOTE[t.rel] || t.rel}. ${PRICE_NOTE[t.price] || t.price}. Compare it with other ${t.cat} tools on the Okiru AI Tool Advisor.`.slice(0, 320);
  const related = (byCat[t.cat] || []).filter((x) => x.name !== t.name).slice(0, 9);

  /* ---- FAQ data ---- */
  const priceText =
    t.price === "Free" ? "free to use" :
    t.price === "Freemium" ? "available on a freemium model — free tier with paid upgrades" :
    t.price === "Custom" ? "priced based on your custom requirements" : "a paid tool";
  const pricingDetail = b && b.pricing ? b.pricing : "";
  const altList = (byCat[t.cat] || []).filter((x) => x.name !== t.name).slice(0, 4).map((x) => x.name);
  const alts = altList.length ? altList.join(", ") : `other tools in the ${t.cat} category`;
  const faqItems = [
    { q: `What is ${t.name}?`, a: `${t.name} is a ${t.cat.toLowerCase()} tool. ${t.desc}` },
    {
      q: `How much does ${t.name} cost?`,
      a: `${t.name} is ${priceText}.${pricingDetail ? " " + pricingDetail : ""} For the most current pricing, visit ${t.url}.`,
    },
    ...(b && b.benefits && b.benefits.length
      ? [{ q: `What are the main features of ${t.name}?`, a: `Key features include: ${b.benefits.slice(0, 3).join("; ")}.` }]
      : []),
    ...(b && b.bestFor && b.bestFor.length
      ? [{ q: `Who is ${t.name} best for?`, a: `${t.name} is best for ${b.bestFor.join(", ")}.` }]
      : []),
    ...(b && (b.pros || b.cons)
      ? [{
          q: `What are the pros and cons of ${t.name}?`,
          a: `${b.pros && b.pros.length ? "Pros: " + b.pros.slice(0, 3).join("; ") + "." : ""} ${b.cons && b.cons.length ? "Cons: " + b.cons.slice(0, 3).join("; ") + "." : ""}`.trim(),
        }]
      : []),
    {
      q: `What are alternatives to ${t.name}?`,
      a: `Popular alternatives in the ${t.cat} category include ${alts}. You can compare them side-by-side using the Compare feature on the Okiru AI Tool Advisor.`,
    },
    {
      q: `Is ${t.name} reliable?`,
      a: `${t.name} has a ${t.rel.toLowerCase()} reliability rating from the Okiru AI Tool Advisor based on track record, adoption, and stability of the underlying provider.`,
    },
  ];

  /* ---- JSON-LD ---- */
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: t.name,
        description: t.desc,
        applicationCategory: t.cat,
        operatingSystem: "Web",
        url: canonical,
        sameAs: t.url,
        offers: { "@type": "Offer", price: t.price === "Paid" ? undefined : "0", priceCurrency: "USD", category: t.price },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
          { "@type": "ListItem", position: 2, name: "AI Tools", item: `${ORIGIN}/tools/` },
          { "@type": "ListItem", position: 3, name: t.cat, item: `${ORIGIN}/category/${cat.slug}/` },
          { "@type": "ListItem", position: 4, name: t.name, item: canonical },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: faqItems.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  });

  /* ---- Benefits section ---- */
  const benefitsSection = b && b.benefits && b.benefits.length
    ? `<section>
  <h2>Key features of ${esc(t.name)}</h2>
  <div class="benefit-list">
    ${b.benefits.map((item, i) => `<div class="benefit-item"><div class="benefit-icon">${i + 1}</div><span>${esc(item)}</span></div>`).join("\n    ")}
  </div>
</section>`
    : "";

  /* ---- Best for section ---- */
  const bestForSection = b && b.bestFor && b.bestFor.length
    ? `<section>
  <h2>Who is ${esc(t.name)} best for?</h2>
  <div class="bestfor-list">
    ${b.bestFor.map((bf) => `<span class="bestfor-pill">${esc(bf)}</span>`).join("\n    ")}
  </div>
</section>`
    : "";

  /* ---- Pricing section ---- */
  const pricingSection = pricingDetail
    ? `<section>
  <h2>Pricing</h2>
  <div class="pricing-box"><p>${esc(pricingDetail)}</p></div>
</section>`
    : `<section>
  <h2>Pricing</h2>
  <div class="pricing-box"><p>${esc(PRICE_NOTE[t.price] || t.price)}. Visit <a href="${esc(t.url)}" target="_blank" rel="noopener nofollow" style="color:var(--cyan)">${esc(t.name)}</a> for current pricing details.</p></div>
</section>`;

  /* ---- Pros & Cons section ---- */
  const prosConsSection = b && ((b.pros && b.pros.length) || (b.cons && b.cons.length))
    ? `<section>
  <h2>Pros &amp; Cons</h2>
  <div class="pros-cons">
    ${b.pros && b.pros.length ? `<div class="pc-box pros"><h3>Pros</h3><ul>${b.pros.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
    ${b.cons && b.cons.length ? `<div class="pc-box cons"><h3>Cons</h3><ul>${b.cons.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
  </div>
</section>`
    : "";

  /* ---- FAQ section ---- */
  const faqSection = `<section>
  <h2>Frequently Asked Questions</h2>
  <div class="faq-list">
    ${faqItems
      .map(
        (f) => `<details class="faq-item">
      <summary>${esc(f.q)}</summary>
      <div class="faq-answer">${esc(f.a)}</div>
    </details>`
      )
      .join("\n    ")}
  </div>
</section>`;

  const body = `
<div class="crumbs">
  <a href="/">Home</a> ›
  <a href="/tools/">AI Tools</a> ›
  <a href="/category/${cat.slug}/">${esc(t.cat)}</a> ›
  <span>${esc(t.name)}</span>
</div>
<h1>${esc(t.name)}</h1>
<p class="lede">${esc(t.desc)}</p>
<div class="badges">
  <a class="badge cyan" href="/category/${cat.slug}/">${esc(t.cat)}</a>
  <span class="badge">${esc(PRICE_NOTE[t.price] || t.price)}</span>
  <span class="badge">${esc(REL_NOTE[t.rel] || t.rel)}</span>
  ${t.pick ? `<span class="badge purple">★ Okiru Pick</span>` : ""}
</div>
<div class="cta-row">
  <a class="btn btn-primary" href="${deepLink(t.name)}">Open in AI Advisor →</a>
  <a class="btn btn-ghost" href="${esc(t.url)}" target="_blank" rel="noopener nofollow">Visit ${esc(t.name)} ↗</a>
</div>
${t.tags && t.tags.length ? `<div class="taglist">${t.tags.map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</div>` : ""}
<section>
  <h2>What is ${esc(t.name)}?</h2>
  <p>${esc(t.name)} is an AI tool in the <a href="/category/${cat.slug}/" style="color:var(--cyan)">${esc(t.cat)}</a> category. ${esc(t.desc)} It is rated <strong>${esc(REL_NOTE[t.rel] || t.rel)}</strong> and is <strong>${esc(PRICE_NOTE[t.price] || t.price)}</strong>.</p>
  <p>Want help deciding whether ${esc(t.name)} is right for your goal? The free <a href="${APP}" style="color:var(--cyan)">Okiru AI Tool Advisor</a> recommends the best tool for any task and generates a ready-to-use prompt.</p>
</section>
${benefitsSection}
${bestForSection}
${pricingSection}
${prosConsSection}
${
  related.length
    ? `<section>
  <h2>${esc(t.cat)} alternatives to ${esc(t.name)}</h2>
  <div class="grid">
    ${related
      .map(
        (r) => `<a class="card" href="/tools/${r.slug}/">
      <div class="card-name">${esc(r.name)}</div>
      <div class="card-meta">${esc(r.price)} · ${esc(r.rel)}</div>
      <div class="card-desc">${esc(r.desc.slice(0, 110))}${r.desc.length > 110 ? "…" : ""}</div>
    </a>`
      )
      .join("\n    ")}
  </div>
</section>`
    : ""
}
${faqSection}`;
  return page({ title, description, canonical, jsonld, body, categories, extraCss: EXTRA_CSS });
}

/* ---------- blog page builder ---------- */
function blogPage(post, allPosts, categories) {
  const slug = slugify(post.title);
  const canonical = `${ORIGIN}/blog/${slug}/`;
  const title = `${post.title} | Okiru Blog`;
  const description = (post.excerpt || "").slice(0, 320);

  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt || "",
    datePublished: post.date,
    url: canonical,
    mainEntityOfPage: canonical,
    author: { "@type": "Organization", name: post.author || "Okiru Consulting", url: "https://www.okiru.co.za" },
    publisher: {
      "@type": "Organization",
      name: "Okiru Consulting",
      url: "https://www.okiru.co.za",
      logo: { "@type": "ImageObject", url: `${ORIGIN}/okiru-logo.png` },
    },
    keywords: (post.keywords || []).join(", "),
    articleSection: post.tag || "AI",
    image: post.cover || `${ORIGIN}/opengraph.jpg`,
  });

  /* find prev/next posts (sorted by id desc, same order as blog grid) */
  const sorted = [...allPosts].sort((a, b) => (b.id || 0) - (a.id || 0));
  const idx = sorted.findIndex((p) => p.id === post.id);
  const prev = sorted[idx + 1] || null;
  const next = sorted[idx - 1] || null;

  const tagStyle = `background:${post.tagColor || "#7ee8fa"}18;border:0.5px solid ${post.tagColor || "#7ee8fa"}44;color:${post.tagColor || "#7ee8fa"}`;

  const body = `
<div class="crumbs">
  <a href="/">Home</a> ›
  <a href="/blog/">Blog</a> ›
  <span>${esc(post.title)}</span>
</div>

<div class="blog-post-header">
  <div class="blog-post-eyebrow">
    <span class="blog-tag-pill" style="${tagStyle}">${esc(post.tag || "AI")}</span>
  </div>
  <h1>${esc(post.title)}</h1>
  <div class="blog-post-meta">${esc(post.date)} &middot; ${esc(post.readTime || "")} &middot; By <strong>${esc(post.author || "Okiru Consulting")}</strong></div>
</div>

${post.cover ? `<img class="blog-post-cover" src="${esc(post.cover)}" alt="${esc(post.title)}" loading="lazy">` : ""}

<div class="blog-post-body">
${post.content || ""}
</div>

${post.keywords && post.keywords.length
  ? `<div class="blog-keywords">${post.keywords.map((k) => `<span class="blog-keyword">${esc(k)}</span>`).join("")}</div>`
  : ""}

<div class="blog-nav">
  ${prev ? `<a href="/blog/${slugify(prev.title)}/">← ${esc(prev.title)}</a>` : "<span></span>"}
  ${next ? `<a href="/blog/${slugify(next.title)}/">${esc(next.title)} →</a>` : "<span></span>"}
</div>

<section style="margin-top:64px">
  <h2>More from the Okiru Blog</h2>
  <div class="blog-card-grid">
    ${sorted
      .filter((p) => p.id !== post.id)
      .slice(0, 3)
      .map((p) => {
        const pTagStyle = `background:${p.tagColor || "#7ee8fa"}18;border:0.5px solid ${p.tagColor || "#7ee8fa"}44;color:${p.tagColor || "#7ee8fa"}`;
        return `<a class="blog-card" href="/blog/${slugify(p.title)}/">
      <div class="blog-card-bar" style="background:${p.tagColor || "#7ee8fa"}"></div>
      ${p.cover ? `<div class="blog-card-cover" style="background-image:url('${esc(p.cover)}')"></div>` : ""}
      <div class="blog-card-tag" style="${pTagStyle}">${esc(p.tag || "AI")}</div>
      <div class="blog-card-date">${esc(p.date)}</div>
      <div class="blog-card-title">${esc(p.title)}</div>
      <div class="blog-card-excerpt">${esc((p.excerpt || "").slice(0, 120))}${(p.excerpt || "").length > 120 ? "…" : ""}</div>
      <div class="blog-card-footer">
        <span>${esc(p.author || "Okiru Consulting")}</span>
        <span class="blog-card-arrow">→</span>
      </div>
    </a>`;
      })
      .join("\n    ")}
  </div>
</section>`;

  return page({ title, description, canonical, jsonld, body, categories, extraCss: BLOG_CSS });
}

/* ---------- blog index page builder ---------- */
function blogIndexPage(posts, categories) {
  const canonical = `${ORIGIN}/blog/`;
  const title = "Okiru Blog — AI Insights for South African Business";
  const description = "Straight-talking opinions on AI, automation, and the future of South African business. Published weekly by the Okiru consulting team.";

  const sorted = [...posts].sort((a, b) => (b.id || 0) - (a.id || 0));

  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "Okiru Blog",
    url: canonical,
    description,
    publisher: {
      "@type": "Organization",
      name: "Okiru Consulting",
      url: "https://www.okiru.co.za",
      logo: { "@type": "ImageObject", url: `${ORIGIN}/okiru-logo.png` },
    },
    blogPost: sorted.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      description: p.excerpt || "",
      datePublished: p.date,
      url: `${ORIGIN}/blog/${slugify(p.title)}/`,
      author: { "@type": "Organization", name: p.author || "Okiru Consulting" },
    })),
  });

  const body = `
<div class="crumbs"><a href="/">Home</a> › <span>Blog</span></div>
<h1>Okiru Blog</h1>
<p class="lede">Straight-talking opinions on AI, automation, and the future of South African business — published weekly by the Okiru team.</p>

<div class="blog-card-grid">
${sorted
  .map((p) => {
    const tagStyle = `background:${p.tagColor || "#7ee8fa"}18;border:0.5px solid ${p.tagColor || "#7ee8fa"}44;color:${p.tagColor || "#7ee8fa"}`;
    return `<a class="blog-card" href="/blog/${slugify(p.title)}/">
  <div class="blog-card-bar" style="background:${p.tagColor || "#7ee8fa"}"></div>
  ${p.cover ? `<div class="blog-card-cover" style="background-image:url('${esc(p.cover)}')"></div>` : ""}
  <div class="blog-card-tag" style="${tagStyle}">${esc(p.tag || "AI")}</div>
  <div class="blog-card-date">${esc(p.date)}</div>
  <div class="blog-card-title">${esc(p.title)}</div>
  <div class="blog-card-excerpt">${esc((p.excerpt || "").slice(0, 150))}${(p.excerpt || "").length > 150 ? "…" : ""}</div>
  <div class="blog-card-footer">
    <span>${esc(p.author || "Okiru Consulting")}</span>
    <span>${esc(p.readTime || "")}</span>
    <span class="blog-card-arrow">→</span>
  </div>
</a>`;
  })
  .join("\n")}
</div>`;

  return page({ title, description, canonical, jsonld, body, categories, extraCss: BLOG_CSS });
}

/* ---------- category page builder ---------- */
function categoryPage(cat, tools, categories) {
  const canonical = `${ORIGIN}/category/${cat.slug}/`;
  const title = `${cat.name} — Best AI Tools (${tools.length}) | Okiru AI Tool Advisor`;
  const description = `Browse ${tools.length} ${cat.name} AI tools, with pricing and reliability ratings. Find the right one for your goal with the free Okiru AI Tool Advisor.`;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${cat.name} AI Tools`,
    numberOfItems: tools.length,
    itemListElement: tools.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${ORIGIN}/tools/${t.slug}/`,
      name: t.name,
    })),
  });
  const body = `
<div class="crumbs"><a href="/">Home</a> › <a href="/tools/">AI Tools</a> › <span>${esc(cat.name)}</span></div>
<h1>${esc(cat.name)} AI Tools</h1>
<p class="lede">${tools.length} ${esc(cat.name)} tools reviewed and rated. Click any tool for details, or use the <a href="${APP}" style="color:var(--cyan)">AI Advisor</a> to find the best fit for your goal.</p>
<div class="grid">
  ${tools
    .map(
      (t) => `<a class="card" href="/tools/${t.slug}/">
    <div class="card-name">${esc(t.name)}${t.pick ? " ★" : ""}</div>
    <div class="card-meta">${esc(t.price)} · ${esc(t.rel)} reliability</div>
    <div class="card-desc">${esc(t.desc.slice(0, 120))}${t.desc.length > 120 ? "…" : ""}</div>
  </a>`
    )
    .join("\n  ")}
</div>`;
  return page({ title, description, canonical, jsonld, body, categories });
}

/* ---------- hub page builder ---------- */
const BIZBRAIN_NOTES = {
  "sales-and-crm":
    'Running a small business? <a href="/bizbrain/" style="color:var(--cyan)">Okiru BizBrain</a> combines lead capture, CRM and invoicing in one app from R999pm.',
  "content-and-marketing":
    'Want your social media, blog and client messages handled in one place? See <a href="/bizbrain/" style="color:var(--cyan)">Okiru BizBrain</a>, built for South African small businesses.',
  automation:
    'Prefer one app over five? <a href="/bizbrain/" style="color:var(--cyan)">Okiru BizBrain</a> automates leads, invoicing and social media for small businesses from R999pm.',
};

function hubPage(byCat, categories) {
  const total = categories.reduce((n, c) => n + byCat[c.name].length, 0);
  const canonical = `${ORIGIN}/tools/`;
  const title = `All AI Tools (${total}) — Browse by Category | Okiru AI Tool Advisor`;
  const description = `Browse all ${total} AI tools across ${categories.length} categories — assistants, developer tools, image, video, audio, automation and more. Each tool reviewed with pricing and reliability.`;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "All AI Tools",
    url: canonical,
    description,
  });
  const body = `
<div class="crumbs"><a href="/">Home</a> › <span>AI Tools</span></div>
<h1>All AI Tools</h1>
<p class="lede">${total} AI tools across ${categories.length} categories. Browse below, or let the free <a href="${APP}" style="color:var(--cyan)">Okiru AI Tool Advisor</a> recommend the right one for your goal.</p>
${categories
  .map(
    (c) => `<div class="cat-block">
  <h2><a href="/category/${c.slug}/">${esc(c.name)}</a><span class="cat-count">${byCat[c.name].length} tools</span></h2>
  <div class="linklist">
    ${byCat[c.name].map((t) => `<a href="/tools/${t.slug}/">${esc(t.name)}</a>`).join("\n    ")}
  </div>${BIZBRAIN_NOTES[c.slug] ? `\n  <p style="font-size:13px;color:rgba(255,255,255,.5);margin-top:12px">${BIZBRAIN_NOTES[c.slug]}</p>` : ""}
</div>`
  )
  .join("\n")}`;
  return page({ title, description, canonical, jsonld, body, categories });
}

/* ---------- sitemap builder ---------- */
function sitemap(tools, categories, blogPosts) {
  const urls = [
    { loc: `${ORIGIN}${APP}`, pri: "1.0", freq: "weekly" },
    { loc: `${ORIGIN}/tools/`, pri: "0.9", freq: "weekly" },
    { loc: `${ORIGIN}/blog/`, pri: "0.8", freq: "weekly" },
    { loc: `${ORIGIN}/bizbrain/`, pri: "0.8", freq: "weekly" },
    ...categories.map((c) => ({ loc: `${ORIGIN}/category/${c.slug}/`, pri: "0.7", freq: "weekly" })),
    ...tools.map((t) => ({ loc: `${ORIGIN}/tools/${t.slug}/`, pri: "0.6", freq: "monthly" })),
    ...blogPosts.map((p) => ({ loc: `${ORIGIN}/blog/${slugify(p.title)}/`, pri: "0.7", freq: "weekly" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>
  </url>`
  )
  .join("\n")}
</urlset>
`;
}

/* ---------- inject static content into toolkit.html ---------- */
function injectIntoToolkit(tools, categories, byCat) {
  const toolkitPath = resolve(PUBLIC, "toolkit", "index.html");
  let html = readFileSync(toolkitPath, "utf8");

  /* ---- 1. Inject base JSON-LD ---- */
  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Okiru AI Tool Advisor",
    url: `${ORIGIN}${APP}`,
    description: "Learn to use AI professionally with Okiru — personalised guidance for professionals, teams and founders on the right business-intelligence and productivity tools, plus a plan to put AI to work. Compare 350+ tools. Built by Okiru Consulting.",
    publisher: { "@type": "Organization", name: "Okiru Consulting", url: "https://www.okiru.co.za" },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${ORIGIN}${APP}?tool={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Okiru Consulting",
    alternateName: "Okiru",
    url: "https://www.okiru.co.za",
    logo: `${ORIGIN}/okiru-logo.png`,
    description: "South African AI consulting firm helping organisations build AI strategies, custom chatbots, document intelligence, workflow automation, and team training.",
    areaServed: ["South Africa", "Africa", "Worldwide"],
    sameAs: ["https://www.okiru.co.za", "https://okiru.biz", "https://www.okiru.dev", "https://okiru.pro"],
  };
  const itemListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Okiru AI Tool Advisor — Full AI Tool Directory",
    description: `Complete directory of ${tools.length} AI tools indexed by Okiru AI Tool Advisor.`,
    numberOfItems: tools.length,
    itemListElement: tools.slice(0, 50).map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${ORIGIN}/tools/${t.slug}/`,
      name: t.name,
    })),
  };

  const baseJsonLd = JSON.stringify([websiteSchema, orgSchema, itemListSchema]);

  html = html.replace(
    /<script id="seo-jsonld-base" type="application\/ld\+json">[\s\S]*?<\/script>/,
    () => `<script id="seo-jsonld-base" type="application/ld+json">${baseJsonLd}</script>`
  );

  /* ---- 2. Inject static crawlable directory into #td-categories ---- */
  const dirHtml = categories
    .map((c) => {
      const inCat = byCat[c.name] || [];
      const toolLinks = inCat
        .map((t) => `<a class="td-tool-link" href="/tools/${t.slug}/" data-tool="${t.name.replace(/"/g, "&quot;")}" title="${t.desc.replace(/"/g, "&quot;")}">${t.name}</a>`)
        .join("");
      return `<div class="td-cat"><h3 class="td-cat-title">${c.name} <span style="opacity:.5;font-weight:400">(${inCat.length})</span></h3><div class="td-cat-list">${toolLinks}</div></div>`;
    })
    .join("");

  // Idempotent injection: content is wrapped in <!--td-gen--> markers so
  // re-runs can find and replace it reliably. Falls back to the empty
  // placeholder or the legacy single-line filled block for older files.
  const tdNew = `<div id="td-categories" class="td-categories"><!--td-gen-->${dirHtml}<!--/td-gen--></div>`;
  const tdMarkerRe = /<div id="td-categories" class="td-categories">(?:<!--td-gen-->[\s\S]*?<!--\/td-gen-->)?<\/div>/;
  const tdLegacyLineRe = /^([ \t]*)<div id="td-categories" class="td-categories">.*<\/div>[ \t]*$/m;
  if (tdMarkerRe.test(html)) {
    html = html.replace(tdMarkerRe, () => tdNew);
  } else if (tdLegacyLineRe.test(html)) {
    html = html.replace(tdLegacyLineRe, (_m, ws) => ws + tdNew);
  } else {
    throw new Error("[gen-seo] #td-categories block not found in toolkit/index.html — directory injection failed");
  }

  writeFileSync(toolkitPath, html);
  console.log("[gen-seo] Injected static JSON-LD and directory into toolkit.html");
}

/* ---------- run ---------- */
function main() {
  const tools = loadTools();
  const benefits = loadBenefits();
  const blogPosts = loadBlogPosts();

  // assign unique slugs to tools
  const seen = new Map();
  for (const t of tools) {
    let s = slugify(t.name);
    if (seen.has(s)) {
      const n = seen.get(s) + 1;
      seen.set(s, n);
      s = `${s}-${n}`;
    } else {
      seen.set(s, 1);
    }
    t.slug = s;
  }

  // category order: by tool count desc, stable
  const counts = {};
  for (const t of tools) counts[t.cat] = (counts[t.cat] || 0) + 1;
  const categories = [...new Set(tools.map((t) => t.cat))]
    .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
    .map((name) => ({ name, slug: slugify(name) }));

  const byCat = {};
  for (const c of categories) byCat[c.name] = tools.filter((t) => t.cat === c.name);

  // clean output dirs
  for (const d of ["tools", "category", "blog"]) {
    const p = resolve(PUBLIC, d);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    mkdirSync(p, { recursive: true });
  }

  let count = 0;

  // Legacy redirect stub: keeps old /<dir>/<slug>.html URLs working after the
  // move to clean directory URLs (/<dir>/<slug>/). Meta refresh 0 is treated
  // as a permanent redirect by search engines; canonical points at the new URL.
  const redirectStub = (target, title) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="canonical" href="${ORIGIN}${target}">
<script>location.replace(${JSON.stringify(target)}+location.search+location.hash);</script>
<meta http-equiv="refresh" content="0;url=${target}">
</head>
<body>
<p>This page has moved to <a href="${target}">${esc(`okiru.biz${target}`)}</a></p>
</body>
</html>
`;

  // tool pages: /tools/<slug>/ (+ legacy /tools/<slug>.html redirect)
  for (const t of tools) {
    mkdirSync(resolve(PUBLIC, "tools", t.slug), { recursive: true });
    writeFileSync(resolve(PUBLIC, "tools", t.slug, "index.html"), toolPage(t, categories, byCat, benefits));
    writeFileSync(resolve(PUBLIC, "tools", `${t.slug}.html`), redirectStub(`/tools/${t.slug}/`, t.name));
    count++;
  }

  // category pages: /category/<slug>/ (+ legacy redirect)
  for (const c of categories) {
    mkdirSync(resolve(PUBLIC, "category", c.slug), { recursive: true });
    writeFileSync(resolve(PUBLIC, "category", c.slug, "index.html"), categoryPage(c, byCat[c.name], categories));
    writeFileSync(resolve(PUBLIC, "category", `${c.slug}.html`), redirectStub(`/category/${c.slug}/`, c.name));
    count++;
  }

  // hub: /tools/ (+ legacy /tools.html redirect)
  writeFileSync(resolve(PUBLIC, "tools", "index.html"), hubPage(byCat, categories));
  writeFileSync(resolve(PUBLIC, "tools.html"), redirectStub("/tools/", "All AI Tools"));
  count++;

  // blog pages: /blog/<slug>/ (+ legacy redirect)
  for (const post of blogPosts) {
    const slug = slugify(post.title);
    mkdirSync(resolve(PUBLIC, "blog", slug), { recursive: true });
    writeFileSync(resolve(PUBLIC, "blog", slug, "index.html"), blogPage(post, blogPosts, categories));
    writeFileSync(resolve(PUBLIC, "blog", `${slug}.html`), redirectStub(`/blog/${slug}/`, post.title));
    count++;
  }

  // blog index
  if (blogPosts.length) {
    writeFileSync(resolve(PUBLIC, "blog", "index.html"), blogIndexPage(blogPosts, categories));
    count++;
  }

  // sitemap
  writeFileSync(resolve(PUBLIC, "sitemap.xml"), sitemap(tools, categories, blogPosts));

  console.log(`[gen-seo] ${tools.length} tools, ${categories.length} categories, ${blogPosts.length} blog posts → ${count} pages + sitemap.xml`);

  // inject static content into toolkit.html
  injectIntoToolkit(tools, categories, byCat);
}

main();
