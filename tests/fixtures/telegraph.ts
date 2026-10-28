export const telegraphUrl = 'https://www.telegraph.co.uk/football/2026/10/28/china-reject-mbappe-real-madrid-apologies-mao-joke/';
export const telegraphUrlTitle = 'China reject mbappe real madrid apologies mao joke';
export const telegraphBlocked = () => new Response('<h1>Access Issue Help</h1><p>You are not authorized to access this content without a valid TollBit Token.</p>', {
  status: 402, headers: { 'content-type': 'text/html; charset=utf-8' },
});
