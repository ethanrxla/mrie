# Reddit connection

MRE's Reddit capability is a read-only client for the official Reddit Data API. It
does not scrape public JSON pages and has no methods for posting, voting, commenting,
deleting, messaging, or changing subscriptions.

[Reddit's Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy),
updated June 2026, requires explicit approval before accessing Reddit data through
the Data API. Obtain that approval (explicit written approval for commercial use)
and comply with Reddit's current developer terms before enabling this connector. MRE
keeps the connector inactive and reports a coverage gap until approved OAuth
credentials are configured.

## Configuration

After approval, create an OAuth application in the Reddit account that MRE should
read. Complete an authorization-code grant with `duration=permanent` and the minimum
`read` scope, then store the resulting refresh token in the root `.env` file:

```dotenv
REDDIT_CLIENT_ID=your_oauth_client_id
REDDIT_CLIENT_SECRET=your_oauth_client_secret
REDDIT_REFRESH_TOKEN=your_permanent_refresh_token
REDDIT_USER_AGENT=windows:mre-personal-assistant:0.1 (by /u/your_reddit_username)
```

The user agent should be unique and identify the application, version, platform, and
operator account. Never commit the populated `.env` file.

In `config/mrie.yaml`, leave `reddit.subreddits` empty to use the authenticated
account's best/home listing in briefings, or select up to 20 subreddit names:

```yaml
reddit:
  subreddits: [netsec, cybersecurity, technology]
  listing: hot
  include_nsfw: false
```

Restart MRE after changing environment or YAML configuration. Scheduled and manual
briefings then collect up to 15 Reddit posts and retain only bounded citation metadata
in briefing history. Raw Reddit feed text is treated as untrusted external evidence.

## Runtime behavior

- Access tokens are refreshed in memory and never written to briefing storage.
- OAuth and API redirects are rejected so authorization headers cannot cross origins.
- Results, response sizes, timeouts, and configured subreddit counts are bounded.
- Provider error bodies are discarded; dashboard and agent errors contain no secrets.
- A missing or rejected OAuth configuration is reported as a coverage gap, never as
  an empty feed.
