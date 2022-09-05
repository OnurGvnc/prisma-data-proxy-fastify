import { $ } from 'zx'
import autocannon from 'autocannon'

const instance = autocannon({
  connections: 10,
  duration: 10,
  //
  url: 'https://localhost:3010/*',
  headers: {
    accept: 'application/json, multipart/mixed',
    'accept-language': 'en-US,en;q=0.9,tr;q=0.8,ar;q=0.7,az;q=0.6',
    authorization: 'Bearer topsecretkey',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    pragma: 'no-cache',
    'sec-ch-ua':
      '"Chromium";v="104", " Not A;Brand";v="99", "Google Chrome";v="104"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie:
      'next-auth.csrf-token=3a057a775eef27f9f2df01070723259838c800aecaa4ccbcc6625590e3873a1a%7C2ccddb59d8e131360091e084239a8ce470760cbb3b08538596cfe3952d3984fa; next-auth.callback-url=http%3A%2F%2Flocalhost%3A3000',
    Referer: 'https://localhost:3010/graphiql',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  },
  body: '{"query":"{\\n  findManyurun(where: {\\n    isActive: 1\\n    isDraft: 0\\n    ID: 365\\n  }) {\\n    ID\\n    isActive\\n    status\\n    tmp\\n  }\\n}"}',
  method: 'POST',
})

process.once('SIGINT', () => {
  instance.stop()
})

autocannon.track(instance, { renderProgressBar: false })
