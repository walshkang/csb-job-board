const dns = require('dns');
dns.lookup('api.notion.com', (err, address, family) => {
  if (err) {
    console.error('DNS Lookup Error:', err);
  } else {
    console.log('Address:', address, 'Family: IPv', family);
  }
});
