// Server-rendered pages share the site chrome from public/index.html and public/styles.css.

export function sitePage(options: {
  status: number;
  title: string;
  body: string;
  head?: string;
  script?: string;
}) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>CascadiaJS | ${options.title}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="https://use.typekit.net/nln6hzq.css">
  <link rel="stylesheet" href="/styles.css">
  <script src="/analytics.js" defer></script>
  ${options.head ?? ""}
</head>
<body>
<header class="site-nav">
  <div class="inner">
    <a class="logo" href="https://cascadiajs.com/"><img src="/images/cjs-icon-blue.svg" alt="CascadiaJS"></a>
    <nav class="links">
      <a href="https://cascadiajs.com/2027">CascadiaJS 2027</a>
      <a href="https://cascadiajs.com/code-of-conduct">Code of Conduct</a>
    </nav>
  </div>
</header>
<main>
  <div class="page-title">
    <div class="column"><h1>${options.title}</h1></div>
  </div>
  <div class="column">
    ${options.body}
  </div>
</main>
<footer class="site-footer">
  <div class="inner">
    <h2>CascadiaJS - a Web + AI conf for the PNW</h2>
    <nav class="links">
      <a href="https://cascadiajs.com/">cascadiajs.com</a>
      <a href="https://cascadiajs.com/privacy">Privacy Policy</a>
      <a href="mailto:info@cascadiajs.com">Send us an email</a>
    </nav>
  </div>
</footer>
${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`,
    { status: options.status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
