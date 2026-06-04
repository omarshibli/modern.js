// BFF 函数示例：前端可直接 `import hello from '@api/index'` 调用，自动转成 HTTP 请求。
// 详见 guides/advanced-features/bff.mdx。
export default async () => {
  return { message: 'Hello Modern.js BFF' };
};
