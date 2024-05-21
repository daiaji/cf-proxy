// 全局配置和常量
const CONFIG = {
	useJsDelivr: true,
	errorPageMessage: '无法访问请求的资源。请稍后再试。',
	errorPageStatus: 500,
	ASSET_URL: 'https://daiaji.github.io/cf-proxy/',
	GITHUB_BASE_URL: 'https://cdn.jsdelivr.net/gh',
};

// 辅助函数
const isGitHubUrl = (targetUrl: string): boolean =>
	/^(https?:\/\/)?(www\.)?(github\.com|raw\.githubusercontent\.com)\/.+\/.+\/(blob|raw)\/.+/i.test(targetUrl);

const useJsDelivrForGitHubFiles = (targetUrl: string): string =>
	CONFIG.useJsDelivr
		? targetUrl.replace(/\/(blob|raw)\//, '@').replace(/^(https?:\/\/)?(github\.com|raw\.githubusercontent\.com)/, CONFIG.GITHUB_BASE_URL)
		: targetUrl;

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

const modifyHeaders = (headers: Headers, keys: (string | RegExp)[]): Headers => {
	const newHeaders = new Headers(headers);
	for (const key of headers.keys()) {
		if (keys.some((k) => (typeof k === 'string' ? k === key : k.test(key)))) {
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

const generateHomePage = async (assetUrl: string): Promise<Response> => {
	try {
		const response = await fetch(assetUrl + 'index.html');
		if (!response.ok) throw new Error('Error fetching static HTML page.');
		return new Response(await response.text(), {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} catch (error) {
		console.error('获取静态HTML时出错：', error);
		return generateErrorPage(CONFIG.errorPageMessage, CONFIG.errorPageStatus);
	}
};

// 路由和身份验证处理函数
const getRoutes = (routes: Record<string, string>, hostname: string): string | undefined =>
	routes[hostname] || routes[hostname.split('.')[0]];

const parseAuthenticate = (authenticateStr: string): { realm: string; service: string } => {
	const matches = authenticateStr.match(/(?<=\=")(?:\\.|[^"\\])*(?=")/g);
	if (!matches || matches.length < 2) throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
	return {
		realm: matches[0],
		service: matches[1],
	};
};

const fetchToken = async (wwwAuthenticate: { realm: string; service: string }, searchParams: URLSearchParams): Promise<Response> => {
	const url = new URL(wwwAuthenticate.realm);
	if (wwwAuthenticate.service) url.searchParams.set('service', wwwAuthenticate.service);
	if (searchParams.get('scope') !== null) url.searchParams.set('scope', searchParams.get('scope') ?? '');
	return await fetch(url, { method: 'GET', headers: {} });
};

// 请求处理函数
const handleContainerRegistryRequest = async (originalRequest: Request, originalUrl: URL): Promise<Response | null> => {
	const upstream = getRoutes(ROUTES, originalUrl.hostname);
	if (!upstream) return null;

	const extraHeaders = ['WWW-Authenticate'];

	if (originalUrl.pathname === '/v2/') return handleV2Auth(upstream, originalUrl, extraHeaders, originalRequest);
	if (originalUrl.pathname === '/v2/auth') return handleAuth(upstream, originalUrl, extraHeaders, originalRequest);

	if (originalUrl.pathname.includes('/v2/')) {
		const targetUrl = new URL(upstream + originalUrl.pathname).toString();
		return await fetchAndModifyResponse(targetUrl, originalRequest, originalUrl, extraHeaders, [], true);
	}

	return null;
};

const handleAPIRequest = async (originalRequest: Request, originalUrl: URL): Promise<Response | null> => {
	const upstream = getRoutes(API_ROUTES, originalUrl.hostname);
	if (!upstream) return null;

	if (originalRequest.method === 'OPTIONS') {
		const headers = new Headers();
		setCORSHeaders(headers);
		return new Response(null, { headers });
	}

	const targetUrl = new URL(originalUrl.pathname, upstream);
	originalUrl.searchParams.forEach((value, key) => targetUrl.searchParams.append(key, value));

	const extraHeaders = ['x-goog-api-client', 'x-goog-api-key', 'Authorization'];
	return await fetchAndModifyResponse(targetUrl.toString(), originalRequest, originalUrl, extraHeaders, [], true);
};

// 响应修改函数
const fetchAndModifyResponse = async (
	targetUrl: string,
	originalRequest: Request,
	originalUrl: URL,
	extraHeaders: string[] = [],
	deleteHeaders: string[] = [],
	skipCompression: boolean = false
): Promise<Response> => {
	const allowedHeaders = ['Accept', 'Content-Type', 'Content-Length', 'accept-encoding', 'User-Agent', ...extraHeaders];
	const modifiedRequest = new Request(targetUrl, {
		headers: modifyHeaders(originalRequest.headers, allowedHeaders),
		method: originalRequest.method,
		body: originalRequest.body,
		redirect: 'manual',
	});

	try {
		const response = await fetch(modifiedRequest);
		return await modifyResponse(response, originalUrl, targetUrl, deleteHeaders, skipCompression);
	} catch (error) {
		console.error('获取和修改响应时出错：', error);
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
		return createResponse(response.status, modifiedHeaders);
	}

	if (contentType.includes('text/html')) {
		const text = await response.text();
		const modifiedText = rewriteHTML(text, originalUrl, new URL(targetUrl));
		return createResponse(response.status, modifiedHeaders, modifiedText);
	}

	if (contentEncoding && skipCompression) {
		modifiedHeaders.set('Content-Encoding', contentEncoding);
		return createResponse(response.status, modifiedHeaders, response.body, 'manual');
	}

	return createResponse(response.status, modifiedHeaders, response.body);
};

const createResponse = (
	status: number,
	headers: Headers,
	body?: BodyInit,
	encodeBody: 'manual' | 'automatic' = 'automatic'
): Response => new Response(body, { status, headers, encodeBody });

// 主请求处理函数
const handleRequest = async (originalRequest: Request): Promise<Response> => {
	const originalUrl = new URL(originalRequest.url);
	let targetUrl = originalUrl.pathname.slice(1) + originalUrl.search;

	if (!targetUrl) return generateHomePage(CONFIG.ASSET_URL);

	const responseFromRoutes = await handleContainerRegistryRequest(originalRequest, originalUrl);
	if (responseFromRoutes) return responseFromRoutes;

	const responseFromAPI = await handleAPIRequest(originalRequest, originalUrl);
	if (responseFromAPI) return responseFromAPI;

	if (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://')) targetUrl = 'https://' + targetUrl;
	if (isGitHubUrl(targetUrl)) targetUrl = useJsDelivrForGitHubFiles(targetUrl);

	return fetchAndModifyResponse(targetUrl, originalRequest, originalUrl);
};

const handleV2 = async (upstream: string, originalUrl: URL, extraHeaders: string[], originalRequest: Request): Promise<Response> => {
	const newUrl = new URL(`${upstream}/v2/`);
	return await fetchAndModifyResponse(newUrl.toString(), originalRequest, originalUrl, extraHeaders);
};

const handleAuth = async (upstream: string, originalUrl: URL, extraHeaders: string[], originalRequest: Request): Promise<Response> => {
	const resp = await handleV2(upstream, originalUrl, extraHeaders, originalRequest);
	if (resp.status !== 401) return resp;
	const authenticateStr = resp.headers.get('WWW-Authenticate');
	if (!authenticateStr) return resp;
	const wwwAuthenticate = parseAuthenticate(authenticateStr);
	return await fetchToken(wwwAuthenticate, originalUrl.searchParams);
};

const handleV2Auth = async (upstream: string, originalUrl: URL, extraHeaders: string[], originalRequest: Request): Promise<Response> => {
	const resp = await handleV2(upstream, originalUrl, extraHeaders, originalRequest);
	if (resp.status === 401) {
		const headers = new Headers();
		headers.set('Www-Authenticate', `Bearer realm="${originalUrl.origin}/v2/auth",service="cloudflare-docker-proxy"`);
		return new Response(JSON.stringify({ message: 'UNAUTHORIZED' }), { status: 401, headers });
	}
	return resp;
};

// 主请求处理程序和事件监听器
addEventListener('fetch', (event) => {
	event.passThroughOnException();
	event.respondWith(handleRequest(event.request));
});