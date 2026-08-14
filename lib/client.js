window.__ModuleLoader__.load({
  id: "visual-review",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const rowStyle = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" };
    const stackStyle = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px", minWidth: "0", maxWidth: "min(525px, 82%)" };
    const bubbleStyle = { background: "var(--dsw-specific-bubble)", maxWidth: "100%", color: "var(--dsw-alias-label-primary)", borderRadius: "22px", padding: "10px 16px", fontSize: "16px", lineHeight: "24px", whiteSpace: "pre-wrap", wordBreak: "break-word" };
    const imageStyle = { display: "block", maxWidth: "100%", maxHeight: "420px", borderRadius: "8px", objectFit: "contain" };
    const noteStyle = { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: "12px", padding: "2px 0" };

    function extractAttachmentId(text) {
      if (typeof text !== "string") return null;
      const m = /sha256:[a-f0-9]{64}/.exec(text);
      return m ? m[0] : null;
    }

    function VRImage(props) {
      const id = props.id;
      const [failed, setFailed] = React.useState(false);
      React.useEffect(function () { setFailed(false); }, [id]);
      if (failed) return React.createElement("div", { style: noteStyle }, "（图片加载失败）");
      if (!id) return React.createElement("div", { style: noteStyle }, "（图片不可用）");
      return React.createElement("img", { src: "/vr-image/" + encodeURIComponent(id), alt: "图片", style: imageStyle, onError: function () { setFailed(true); } });
    }

    function VRUserNode(props) {
      const node = props && props.node;
      const data = node && node.data;
      const content = data && Array.isArray(data.content) ? data.content : [];
      const images = [];
      const texts = [];
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block) continue;
        if (block.type === "image" && block.attachment) {
          const id = block.attachment && typeof block.attachment.attachmentId === "string" ? block.attachment.attachmentId : null;
          images.push(id);
        } else if (block.type === "text") {
          const id = extractAttachmentId(block.text);
          if (id) images.push(id);
          else if (typeof block.text === "string" && block.text !== "") texts.push(block.text);
        }
      }
      const stack = [];
      for (let i = 0; i < images.length; i++) {
        const id = images[i];
        if (id) stack.push(React.createElement(VRImage, { key: "img" + i, id: id }));
      }
      if (texts.length > 0) {
        stack.push(React.createElement("div", { key: "t", style: bubbleStyle }, texts.map(function (t, i) { return React.createElement("div", { key: i }, t); })));
      }
      return React.createElement("div", { style: rowStyle }, React.createElement("div", { style: stackStyle }, stack));
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("conversation.chat.node", function () {
        return slots.register({ name: "conversation.chat.node", key: "user", priority: -1 }, VRUserNode);
      });
      slots.inject("conversation.chat.node", function () {
        return slots.register({ name: "conversation.chat.node", key: "steering", priority: -2 }, VRUserNode);
      });
    }

    exports.apply = apply;
    return module.exports;
  }
});
