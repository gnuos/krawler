/**
 * 两个原先由Supercrawler库实现的辅助函数都是CPU密集型的处理过程
 * 后续需要改写成多线程后台处理，从页面缓存里面异步拿Response缓存
 */

import { load } from 'cheerio';
import zlib from 'node:zlib';

const nullFilter = function (a) {
  // Some of the maps() might have returned null, so we filter
  // those out here.
  return a !== null;
};

export function HtmlLinkParser(opts) {
  if (!opts) {
    opts = {};
  }

  if (!opts.urlFilter) {
    opts.urlFilter = function () {
      return true;
    };
  }

  return async function (context) {
    var $;

    $ = context.$ || load(context.body);
    context.$ = $;

    return $('a[href], iframe[href], area[href], li[href], span[href]')
      .map(function () {
        let $this, targetHref, absoluteTargetUrl, urlObj, protocol, hostname;

        $this = $(this);
        targetHref = $this.attr('href');
        absoluteTargetUrl = new URL(targetHref, context.url);
        urlObj = new URL(absoluteTargetUrl);
        protocol = urlObj.protocol;
        hostname = urlObj.hostname;

        if (protocol !== 'http:' && protocol !== 'https:') {
          return null;
        }

        // Restrict links to a particular group of hostnames.
        if (typeof opts.hostnames !== 'undefined') {
          if (opts.hostnames.indexOf(hostname) === -1) {
            return null;
          }
        }

        return urlObj.href;
      })
      .get()
      .filter(function (url) {
        return opts.urlFilter(url, context.url);
      });
  };
}

/**
 * This handler parses XML format sitemaps, and extracts links from them,
 * including links to other sitemaps.
 *
 * Sitemap files can also be served as gz files (with an actual
 * application/x-gzip). Unfortunately, that means we have to open up the file
 * to see what is inside.
 *
 * @return {Array} Array of links discovered in the sitemap.
 */
export function SitemapsParser(opts) {
  if (!opts) {
    opts = {};
  }

  if (!opts.urlFilter) {
    opts.urlFilter = function () {
      return true;
    };
  }

  if (typeof opts.gzipContentTypes === 'string') {
    opts.gzipContentTypes = [opts.gzipContentTypes];
  } else if (!Array.isArray(opts.gzipContentTypes)) {
    opts.gzipContentTypes = ['application/x-gzip', 'application/gzip'];
  }

  return async function (context) {
    let xmlBuf;

    // If sitemap has come in compressed state, we must uncompress it!
    if (opts.gzipContentTypes.indexOf(context.contentType) > -1) {
      zlib.gunzip(context.body, (err, buf) => {
        if (err) {
          throw err;
        }

        xmlBuf = buf;
      });
    } else {
      xmlBuf = context.body;
    }

    let sitemapUrls, urlUrls, linkUrls;

    let $ = context.$ || load(xmlBuf);
    context.$ = $;

    // We map over the array rather than using Cheerio's map, because it is
    // a lot faster. It's important when we are dealing with very large
    // sitemaps.
    sitemapUrls = $('sitemapindex > sitemap > loc')
      .get()
      .map(function (el) {
        const match = el.children.filter(function (child) {
          return child.type === 'text';
        });

        return match ? match.data : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    urlUrls = $('urlset > url > loc')
      .get()
      .map(function (el) {
        const match = el.children.filter(function (child) {
          return child.type === 'text';
        });

        return match ? match[0].data : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    linkUrls = $('urlset > url > xhtml\\:link[href][rel=alternate]')
      .get()
      .map(function (el) {
        return el.attribs.href ? el.attribs.href : null;
      })
      .filter(nullFilter)
      .filter(opts.urlFilter);

    return sitemapUrls.concat(urlUrls).concat(linkUrls);
  };
}
