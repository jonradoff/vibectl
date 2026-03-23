package client

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// NewReverseProxy creates a reverse proxy targeting remoteServerURL.
// All incoming request headers (including Authorization) are forwarded
// transparently, so user session tokens from the remote server work normally.
// If apiKey is non-empty and the request carries no Authorization header,
// it is injected for machine-to-machine calls.
func NewReverseProxy(remoteServerURL, apiKey string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(remoteServerURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	defaultDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		defaultDirector(req)
		req.Host = target.Host

		// Inject API key only when no user session token is present.
		if apiKey != "" && req.Header.Get("Authorization") == "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
		}
	}

	return proxy, nil
}
