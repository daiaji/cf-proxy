// 全局配置和常量
const CONFIG = {
    useJsDelivr: true,
    errorPageMessage: '无法访问请求的资源。请稍后再试。',
    errorPageStatus: 500,
    ASSET_URL: 'https://daiaji.github.io/cf-proxy/',
    GITHUB_BASE_URL: 'https://cdn.jsdelivr.net/gh',
};

// 辅助函数
const isGitHubUrl = (url: string): boolean =>
    /^(https?:\/\/)?(www\.)?(github\.com|raw\.githubusercontent\.com)\/.+\/.+\/(blob|raw)\/.+/i.test(url);

const useJsDelivrForGitHubFiles = (url: string): string =>
    CONFIG.useJsDelivr
        ? url.replace(/\/(blob|raw)\//, '@').replace(/^(https?:\/\/)?(github\.com|raw\.githubusercontent\.com)/, CONFIG.GITHUB_BASE_URL)
        : url;

const generateErrorPage = (message: string, status: number): Response =>
    new Response(`<html><body><h1>Error</h1><p>${message}</p></body></html>`, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

const setCORSHeaders = (headers: Headers): void => {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    headers.set('Access-Control-Max-Age', '1728000');
};

const modifyHeaders = (headers: Headers, allowedKeys: (string | RegExp)[]): Headers => {
    const newHeaders = new Headers(headers);
    for (const key of headers.keys()) {
        if (allowedKeys.some((k) => (typeof k === 'string' ? k === key : k.test(key)))) {
            newHeaders.set(key, headers.get(key) ?? '');
        }
    }
    return newHeaders;
};

const rewriteHTML = (html: string, originalUrl: URL, targetUrl: URL): string => {
    const regex = /(href|src|action)="([^"]*)"/g;
    return html.replace(regex, (match, attribute, value) => {
        if (value.startsWith('/') || value.startsWith('http')) {
            const absoluteUrl = new URL(value, targetUrl).toString();
            const proxiedUrl = `${originalUrl.origin}/${absoluteUrl}`;
            return `${attribute}="${proxiedUrl}"`;
        }
        return match;
    });
};

const generateHomePage = async (assetUrl: string, originalUrl: URL): Promise<Response> => {
    const targetUrl = assetUrl + 'index.html';
    return await fetchAndModifyResponse(targetUrl, new Request(targetUrl), originalUrl);
};

// 路由和身份验证处理函数
const getRoute = (routes: Record<string, string>, hostname: string): string | undefined =>
    routes[hostname] || routes[hostname.split('.')[0]];

const parseAuthenticateHeader = (header: string): { realm: string; service: string } => {
    const matches = header.match(/(?<=\=")(?:\\.|[^"\\])*(?=")/g);
    if (!matches || matches.length < 2) throw new Error(`Invalid WWW-Authenticate Header: ${header}`);
    return {
        realm: matches[0],
        service: matches[1],
    };
};

const fetchToken = async (authHeader: { realm: string; service: string }, searchParams: URLSearchParams): Promise<Response> => {
    const url = new URL(authHeader.realm);
    if (authHeader.service) url.searchParams.set('service', authHeader.service);
    if (searchParams.get('scope') !== null) url.searchParams.set('scope', searchParams.get('scope') ?? '');
    return await fetch(url, { method: 'GET', headers: {} });
};

// 请求处理函数
const handleContainerRegistryRequest = async (request: Request, url: URL): Promise<Response | null> => {
    const upstream = getRoute(ROUTES, url.hostname);
    if (!upstream) return null;

    const extraHeaders = ['WWW-Authenticate'];

    if (url.pathname === '/v2/') return handleV2(upstream, url, extraHeaders, request);
    if (url.pathname === '/v2/auth') return handleAuth(upstream, url, extraHeaders, request);

    if (url.pathname.startsWith('/v2/')) {
        const targetUrl = new URL(upstream + url.pathname).toString();
        return await fetchAndModifyResponse(targetUrl, request, url, extraHeaders, [], true);
    }

    return null;
};

const handleAPIRequest = async (request: Request, url: URL): Promise<Response | null> => {
    const upstream = getRoute(API_ROUTES, url.hostname);
    if (!upstream) return null;

    if (request.method === 'OPTIONS') {
        const headers = new Headers();
        setCORSHeaders(headers);
        return new Response(null, { headers });
    }

    let targetUrl = new URL(url.pathname, upstream);
    url.searchParams.forEach((value, key) => targetUrl.searchParams.append(key, value));

    const extraHeaders = ['x-goog-api-client', 'x-goog-api-key', 'Authorization'];
    return await fetchAndModifyResponse(targetUrl.toString(), request, url, extraHeaders, []);
};

// 响应修改函数
const fetchAndModifyResponse = async (
    targetUrl: string,
    request: Request,
    originalUrl: URL,
    extraHeaders: string[] = [],
    deleteHeaders: string[] = [],
    skipCompression: boolean = false
): Promise<Response> => {
    const allowedHeaders = ['Accept', 'Content-Type', 'Content-Length', 'accept-encoding', 'User-Agent', ...extraHeaders];
    const modifiedRequest = new Request(targetUrl, {
        headers: modifyHeaders(request.headers, allowedHeaders),
        method: request.method,
        body: request.body,
        redirect: 'manual',
    });

    try {
        const response = await fetch(modifiedRequest);
        return await modifyResponse(response, originalUrl, targetUrl, deleteHeaders, skipCompression);
    } catch (error) {
        console.error('Error fetching and modifying response:', error);
        return generateErrorPage(CONFIG.errorPageMessage, CONFIG.errorPageStatus);
    }
};

const modifyResponse = async (
    response: Response,
    originalUrl: URL,
    targetUrl: string,
    deleteHeaders: string[] = [],
    skipCompression: boolean = false
): Promise<Response> => {
    const modifiedHeaders = new Headers(response.headers);
    setCORSHeaders(modifiedHeaders);
    deleteHeaders.forEach((header) => modifiedHeaders.delete(header));

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    const contentType = response.headers.get('Content-Type') || '';
    const contentEncoding = response.headers.get('Content-Encoding') || '';

    if (isRedirect) {
        const locationHeader = originalUrl.origin + "/" + response.headers.get('Location');
        if (locationHeader) {
            const newLocation = new URL(locationHeader, originalUrl).href;
            modifiedHeaders.set('Location', new URL(newLocation, targetUrl).href);
        }
        return new Response(null, { status: response.status, headers: modifiedHeaders });
    }

    if (contentType.includes('text/html')) {
        const text = await response.text();
        const modifiedText = rewriteHTML(text, originalUrl, new URL(targetUrl));
        return new Response(modifiedText, { status: response.status, headers: modifiedHeaders });
    }

    if (contentEncoding && skipCompression) {
        modifiedHeaders.set('Content-Encoding', contentEncoding);
        return new Response(response.body, { status: response.status, headers: modifiedHeaders });
    }

    return new Response(response.body, { status: response.status, headers: modifiedHeaders });
};

// 主请求处理函数
const handleRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url); // 这里的 url 可以是 const
    url.pathname = url.pathname.replace(/^\/+/, '/'); // pathname 是一个属性，可以被修改
    let targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl) return generateHomePage(CONFIG.ASSET_URL, url);

    const responseFromRegistry = await handleContainerRegistryRequest(request, url);
    if (responseFromRegistry) return responseFromRegistry;

    const responseFromAPI = await handleAPIRequest(request, url);
    if (responseFromAPI) return responseFromAPI;

    if (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://')) targetUrl = 'https://' + targetUrl;
    if (isGitHubUrl(targetUrl)) targetUrl = useJsDelivrForGitHubFiles(targetUrl);

    return fetchAndModifyResponse(targetUrl, request, url);
};

const handleV2 = async (upstream: string, url: URL, extraHeaders: string[], request: Request): Promise<Response> => {
    const newUrl = new URL(`${upstream}/v2/`);
    return await fetchAndModifyResponse(newUrl.toString(), request, url, extraHeaders);
};

const handleAuth = async (upstream: string, url: URL, extraHeaders: string[], request: Request): Promise<Response> => {
    const resp = await handleV2(upstream, url, extraHeaders, request);
    if (resp.status === 401) {
        const authHeader = resp.headers.get('WWW-Authenticate');
        if (authHeader) {
            const wwwAuthenticate = parseAuthenticateHeader(authHeader);
            return await fetchToken(wwwAuthenticate, url.searchParams);
        } else {
            const headers = new Headers();
            headers.set('WWW-Authenticate', `Bearer realm="${url.origin}/v2/auth",service="cloudflare-docker-proxy"`);
            return new Response(JSON.stringify({ message: 'UNAUTHORIZED' }), { status: 401, headers });
        }
    }
    return resp;
};

// 主请求处理程序和事件监听器
addEventListener('fetch', (event) => {
    event.passThroughOnException();
    event.respondWith(handleRequest(event.request));
});