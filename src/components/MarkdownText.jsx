function inlineMarkdown(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export default function MarkdownText({ content }) {
  const blocks = (content || '').split(/\n\n+/);
  return blocks.map((block, bi) => {
    const lines = block.split('\n');

    const headingMatch = lines[0].match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      const Tag = headingMatch[1].length <= 2 ? 'h3' : 'h4';
      return <Tag key={bi}>{inlineMarkdown(headingMatch[2], `h${bi}`)}</Tag>;
    }

    if (lines.every((l) => /^[-*]\s/.test(l.trim()))) {
      return (
        <ul key={bi}>
          {lines.map((l, li) => (
            <li key={li}>{inlineMarkdown(l.replace(/^[-*]\s/, ''), `ul${bi}-${li}`)}</li>
          ))}
        </ul>
      );
    }

    if (lines.every((l) => /^\d+\.\s/.test(l.trim()))) {
      return (
        <ol key={bi}>
          {lines.map((l, li) => (
            <li key={li}>{inlineMarkdown(l.replace(/^\d+\.\s/, ''), `ol${bi}-${li}`)}</li>
          ))}
        </ol>
      );
    }

    const nodes = lines.flatMap((line, li) => {
      const inline = inlineMarkdown(line, `p${bi}-${li}`);
      return li < lines.length - 1 ? [...inline, <br key={`br${bi}-${li}`} />] : inline;
    });
    return <p key={bi}>{nodes}</p>;
  });
}
