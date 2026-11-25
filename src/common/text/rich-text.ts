import sanitizeHtml from 'sanitize-html';
import { ARTICLE_ALLOWED_SCHEMES } from '../../modules/cms/cms.constants';

/**
 * 富文本（资讯正文、联创介绍、福利专场入口文案）都会被 H5/小程序直接渲染。
 * 只放行编辑器会产出的标签和属性，脚本、事件属性、javascript: 一律剔除。
 * 管理端写入前都会过这一层，库里保存的富文本永远是被净化过的。
 */
export function sanitizeRichText(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'del',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'span',
      'div',
      'a',
      'img',
      'figure',
      'figcaption',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
      'sub',
      'sup',
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: [...ARTICLE_ALLOWED_SCHEMES],
    allowedSchemesByTag: { img: [...ARTICLE_ALLOWED_SCHEMES], a: [...ARTICLE_ALLOWED_SCHEMES] },
    // script/style 的内容整个丢掉，不做文本转义。
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'option', 'iframe', 'object', 'embed'],
    // 自闭合标签补全，防止半截 HTML 破坏页面结构。
    selfClosing: ['br', 'hr', 'img'],
  });
}
