const sanitizeHtml = require('sanitize-html')

// Cấu hình sanitize dùng chung cho mọi nội dung rich-text do admin soạn (TinyMCE/ReactQuill)
// trước khi lưu vào DB — chặn XSS (script, event handler, javascript: url...) trong khi vẫn
// giữ lại đầy đủ định dạng hợp lệ mà editor cho phép (bảng, list, màu chữ, ảnh, link...).
const RICH_TEXT_SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'span', 'div',
    'h1', 'h2', 'h3', 'h4',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup',
    'ul', 'ol', 'li',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
    'blockquote', 'code', 'pre', 'hr',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    span: ['style'],
    div: ['style'],
    p: ['style'],
    h1: ['style'], h2: ['style'], h3: ['style'], h4: ['style'],
    li: ['style'],
    table: ['style'], th: ['style', 'width'], td: ['style', 'width'], tr: ['style'],
    // width admin kéo resize từng cột được TinyMCE lưu vào đây (col style="width:...")
    col: ['style', 'width'],
    colgroup: ['style'],
    '*': ['class'], // giữ class do TinyMCE/Quill gắn (VD: ql-align-center) để CSS hiển thị đúng
  },
  // Chỉ cho phép các thuộc tính CSS thật sự cần để hiển thị định dạng — chặn mọi style khác
  // (position, transform, javascript expression cũ trong IE, v.v...)
  allowedStyles: {
    '*': {
      color: [/^.*$/],
      'background-color': [/^.*$/],
      'text-align': [/^.*$/],
      'font-weight': [/^.*$/],
      'font-style': [/^.*$/],
      'text-decoration': [/^.*$/],
      'font-size': [/^[\d.]+(px|pt|em|rem|%)$/],
      'font-family': [/^[\w\s,'"-]+$/],
      width: [/^[\d.]+(%|px|pt)$/],
      'text-indent': [/^.*$/],
    },
  },
  // Chỉ cho phép link http/https/mailto — chặn javascript:, data: (trừ ảnh), vbscript:...
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'], // cho phép ảnh base64 (paste ảnh trực tiếp từ clipboard)
  },
  // Tự thêm rel="noopener noreferrer" cho link mở tab mới, tránh tabnabbing
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
  allowedIframeHostnames: [], // không cho nhúng iframe từ bất kỳ đâu
  disallowedTagsMode: 'discard',
}

const sanitizeRichText = (html) => {
  if (!html) return html
  return sanitizeHtml(html, RICH_TEXT_SANITIZE_OPTIONS)
}

module.exports = { sanitizeRichText, RICH_TEXT_SANITIZE_OPTIONS }