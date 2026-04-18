package delegation

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// NewDelegationProxy creates a reverse proxy that always injects the delegation API key.
// Unlike the client mode proxy, this always replaces the Authorization header —
// the local user's session token is meaningless to the remote server.
func NewDelegationProxy(remoteURL, apiKey string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(remoteURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	defaultDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		defaultDirector(req)
		req.Host = target.Host
		// Always replace auth with the delegation API key.
		req.Header.Set("Authorization", "Bearer "+apiKey)
		// Remove cookies that might leak to the remote.
		req.Header.Del("Cookie")
	}

	// Don't propagate 401s from the remote as-is — they'd trigger the local
	// auth flow's clearStoredToken. Wrap them as 502 delegation errors.
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.StatusCode == http.StatusUnauthorized {
			resp.StatusCode = http.StatusBadGateway
			resp.Header.Set("X-Delegation-Error", "auth_failed")
		}
		if resp.StatusCode == http.StatusForbidden {
			resp.Header.Set("X-Delegation-Error", "permission_denied")
		}
		return nil
	}

	return proxy, nil
}
