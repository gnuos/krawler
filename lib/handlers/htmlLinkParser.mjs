import { load } from 'cheerio';

export default function (opts) {
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

    return $('a[href], link[href][rel=alternate], area[href]')
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

        return urlObj;
      })
      .get()
      .filter(function (url) {
        return opts.urlFilter(url, context.url);
      });
  };
}
