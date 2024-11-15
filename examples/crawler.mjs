/* globals console */
import { Crawler, Url, HtmlLinkParser, SitemapsParser } from '../lib/index.mjs';

let crawler = new Crawler();

crawler.on('crawlurl', function (url) {
  console.log('开始抓取:', url);
});

crawler.on('urllistempty', function () {
  console.warn('队列中没有链接');

  crawler.stop();
});

crawler.on('handlersError', function (err) {
  console.error(err);
});

crawler.on('httpError', function (err, url) {
  console.error(url, err.message);
});

crawler.on('urllistcomplete', function () {
  console.log('所有链接已经爬完');

  crawler.stop();
});

crawler.addHandler('application/xml', SitemapsParser());

crawler.addHandler('text/html', async function (ctx) {
  let sizeKb = Buffer.byteLength(ctx.body) / 1024;
  console.log('处理页面:', ctx.url, '字节数', sizeKb, 'KB');

  const parse = HtmlLinkParser({ hostnames: ['cheerio.js.org'] });
  const links = await parse(ctx);

  console.log('爬取的页面中包含的链接数:', links.length);
  console.log();
});

(async function () {
  await crawler.getUrlList().insertIfNotExists(
    new Url({
      url: 'https://cheerio.js.org/'
    })
  );

  crawler.start();
})();
