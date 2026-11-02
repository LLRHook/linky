export const telegraphUrl = 'https://www.telegraph.co.uk/football/2026/10/28/china-reject-mbappe-real-madrid-apologies-mao-joke/';
export const telegraphUrlTitle = 'China reject mbappe real madrid apologies mao joke';
export const telegraphBlocked = () => new Response('<h1>Access Issue Help</h1><p>You are not authorized to access this content without a valid TollBit Token.</p>', {
  status: 402, headers: { 'content-type': 'text/html; charset=utf-8' },
});
export const telegraphHeadline = 'China rejects Mbappe and Real Madrid apologies over ‘outrageous’ Mao joke';
export const telegraphExcerpt = 'State broadcaster doubles down on vow to stop showing matches involving France captain after he made comment about country’s founding leader ...';
export const telegraphThumbnail = 'https://www.bing.com/th?id=ONUT.5CJL6fHLD5Qxv6lp5iX6FA&pid=News';
export const bingItem = (url: string, title: string, image = 'http://www.bing.com/th?id=ONUT.5CJL6fHLD5Qxv6lp5iX6FA&amp;pid=News') =>
  `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=6ae354239b0b49ee8161539262fd3da0&amp;url=${encodeURIComponent(url)}&amp;c=5984673423776107570&amp;mkt=en-us</link><description>${telegraphExcerpt}</description><pubDate>Wed, 28 Oct 2026 07:03:00 GMT</pubDate><News:Source>The Telegraph</News:Source><News:Image>${image}</News:Image></item>`;
/** Bing News RSS as served for the reported article's slug search on 2026-10-29: an older related story, then the article. */
export const bingNewsFeed = (items = [bingItem(telegraphUrl.replace('2026/10/28/china-reject-mbappe-real-madrid-apologies-mao-joke', '2024/07/16/kylian-mbappe-real-madrid-unveiling-fans-galacticos'),
  'Kylian Mbappe’s Real Madrid unveiling in front of 80,000 fans as new galactico echoes Ronaldo'), bingItem(telegraphUrl, telegraphHeadline)]) =>
  new Response(`<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?format=rss"><channel><title>BingNews</title>${items.join('')}</channel></rss>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8' } });
