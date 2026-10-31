/*!
 * dsh-chat-link-actions — client half.
 *
 * Right-click menu for file links in the transcript, drawn in the app's own
 * style (theme tokens, radius, elevation, blur) instead of the WebView's native
 * menu. Two actions:
 *
 *   引用到对话               insert `@path` into the composer as one undoable edit
 *   在文件管理器中查看    reveal the file in the OS file manager (服务端接口)
 *
 * Wiring:
 * - `inputActions` is a standard prop of session-scoped slots
 *   (`ctx.uiSession.provide({ props: ["inputActions"] })` in ui-conversation).
 *   A zero-size occupant of `conversation.input.overlay` captures it per
 *   session; the menu uses `captureInsertion()` + `insertText(text, span)`,
 *   which only lands while the captured `draftRev` is still current.
 * - Revealing needs process access, so it runs in the 服务端半
 *   (`POST /chat-link-actions`).
 *
 * Bundle format: the official client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }).
 */
window.__ModuleLoader__.load({
  id: "dsh-chat-link-actions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");

    /* ── composer draft handles ─────────────────────────────────────────── */

    /** SessionId -> inputActions for that session's composer. */
    var drafts = new Map();
    /** Client root context, kept for the session-scoped chip event. */
    var rootContext = null;
    /** Session whose composer rendered most recently. */
    var activeSession = null;

    function readInputActions(props) {
      if (props === null || typeof props !== "object") return null;
      var candidates = [props.inputActions, props.actions, props.input && props.input.actions];
      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        if (candidate !== null && typeof candidate === "object" && typeof candidate.insertText === "function") {
          return candidate;
        }
      }
      return null;
    }

    /** Invisible occupant: remembers the composer handle of the session it rendered for. */
    function DraftCapture(props) {
      var actions = readInputActions(props);
      var sessionId = props.sessionId;
      if (actions !== null) {
        if (sessionId !== undefined) drafts.set(sessionId, actions);
        activeSession = sessionId === undefined ? activeSession : sessionId;
      }
      return null;
    }

    function draftCandidates() {
      var ordered = [];
      var seen = [];
      function add(sessionId) {
        if (sessionId === undefined || sessionId === null) return;
        var actions = drafts.get(sessionId);
        if (actions === undefined || seen.indexOf(actions) !== -1) return;
        seen.push(actions);
        ordered.push({ sessionId: sessionId, actions: actions });
      }
      add(activeSession);
      drafts.forEach(function (_actions, sessionId) {
        add(sessionId);
      });
      return ordered;
    }

    /** `@path`; a path containing whitespace uses the quoted mention form. */
    function referenceText(path) {
      return /[\s"]/.test(path) ? '@"' + path.replace(/"/g, '\\"') + '"' : "@" + path;
    }

    /** Directory links carry a trailing separator; files never do. */
    function looksLikeDirectory(path) {
      return path.charAt(path.length - 1) === "/" || path.charAt(path.length - 1) === "\\";
    }

    /** 问不到会话时只好按形状猜：末尾没有扩展名，多半是目录。 */
    function guessDirectory(path) {
      if (looksLikeDirectory(path)) return true;
      var trimmed = path.replace(/[\\/]+$/, "");
      var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      var name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
      if (name.charAt(0) === ".") return true;
      return !/\.[A-Za-z0-9]{1,8}$/.test(name);
    }

    /** Last path segment, the same label the composer's own reference chips show. */
    function displayLabel(path, directory) {
      var trimmed = path.replace(/[\\/]+$/, "");
      var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      var name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
      if (name === "") name = trimmed;
      return directory ? name + "/" : name;
    }

    /**
     * Insert the reference as the composer's own reference chip (the `(</> name)`
     * node), which the shell only builds for its file-drop and `@`-picker paths.
     * The shell owns that insertion behind a session-scoped event; when the event
     * is not reachable the caller falls back to plain `insertText`.
     */
    function insertChip(sessionId, actions, path, knownDirectory) {
      if (rootContext === null || typeof rootContext.sessions !== "object" || rootContext.sessions === null) return false;
      var binding = null;
      try {
        binding = rootContext.sessions.binding(sessionId);
      } catch (error) {
        return false;
      }
      var sessionContext = binding === null || binding === undefined ? null : binding.ctx;
      if (sessionContext === null || sessionContext === undefined || typeof sessionContext.emit !== "function") return false;
      var before = actions.captureInsertion();
      if (before === null || before === undefined) return false;
      var directory = typeof knownDirectory === "boolean" ? knownDirectory : looksLikeDirectory(path);
      var mention = referenceText(path);
      var reference = {};
      reference.source = "reference";
      reference.ref = mention;
      reference.label = displayLabel(path, directory);
      reference.appearance = directory ? "folder" : "file";
      reference.clipboardText = mention;
      var request = {};
      request.reference = reference;
      request.span = before;
      var delivered = false;
      try {
        /* 宿主按第一个参数（作用域上下文）过滤监听器：只传事件名时请求会
           落到所有打开的输入框，两个会话各挂一份草稿就一起被改。 */
        delivered = sessionContext.emit(sessionContext, "slash/input-insert-reference", request);
      } catch (error) {
        return false;
      }
      if (delivered === false) return false;
      var after = actions.captureInsertion();
      if (after === null || after === undefined) return true;
      return after.start !== before.start || after.end !== before.end;
    }

    /**
     * Insert into the composer of the session the click came from — never into
     * "whichever composer happens to be writable". A reference that lands in
     * another conversation is worse than a failed click, so an unusable source
     * session stops here with a message instead of trying elsewhere.
     */
    function quoteIntoComposer(path, knownDirectory, sessionId) {
      var actions = sessionId === undefined || sessionId === null ? undefined : drafts.get(sessionId);
      if (actions === undefined) {
        report("quote-no-session " + String(sessionId));
        toast(strings().quoteFailed);
        return false;
      }
      try {
        if (typeof actions.captureInsertion !== "function") {
          toast(strings().quoteFailed);
          return false;
        }
        if (insertChip(sessionId, actions, path, knownDirectory)) return true;
        var span = actions.captureInsertion();
        if (span === null || span === undefined) {
          toast(strings().quoteFailed);
          return false;
        }
        if (actions.insertText(referenceText(path) + " ", span) === true) return true;
      } catch (error) {
        report("quote-threw " + String((error && error.message) || error));
      }
      toast(strings().quoteFailed);
      return false;
    }

    /* ── resolving a file path out of the clicked node ──────────────────── */

    /** Trim a candidate down to the bare file path a link carries. */
    /** Drop sentence punctuation that followed the path in prose. */
    var PROSE_CLOSERS = { ")": "(", "]": "[", "\uff09": "\uff08", "\u300d": "\u300c", "\u3011": "\u3010", "\u300b": "\u300a", "\u3015": "\u3014", "\u3009": "\u3008" };

    function trimProsePunctuation(value) {
      var text = value.replace(/[.,;:!?]+$/u, "");
      while (text.length > 1) {
        var close = text.charAt(text.length - 1);
        var open = PROSE_CLOSERS[close];
        if (open === undefined) break;
        var opens = text.split(open).length - 1;
        var closes = text.split(close).length - 1;
        if (closes <= opens) break;
        text = text.slice(0, -1);
      }
      return text;
    }

    /**
     * A `file:` URI names exactly one path, so it has one parser instead of a
     * per-entry heuristic. `URL.pathname` alone is not enough: it turns
     * `file:///C:/a` into `/C:/a` and drops the server of `file://srv/share/a`.
     */
    function decodeFileUri(href) {
      if (typeof href !== "string") return null;
      var match = /^file:(\/\/[^/]*)?(\/[^?#]*)?/i.exec(href);
      if (match === null) return null;
      var authority = match[1] === undefined ? "" : match[1].slice(2);
      var rest = decodePercent(match[2] === undefined ? "/" : match[2]);
      if (authority !== "" && authority.toLowerCase() !== "localhost") {
        return "\\\\" + authority + rest.replace(/\//g, "\\");
      }
      if (/^\/[A-Za-z]:[\\/]/.test(rest)) return rest.slice(1);
      return rest;
    }

    /**
     * One candidate → the path it names. Nothing here may invent a different
     * path: no separator is added and no file-name character is stripped.
     * Sentence punctuation is trimmed only for prose (`prose === true`), where
     * the path really is embedded in a sentence.
     */
    function normalizeCandidate(value, prose) {
      if (typeof value !== "string") return null;
      var candidate = value.trim();
      if (candidate === "") return null;
      if (candidate.charAt(0) === "@") candidate = candidate.slice(1).trim();
      if (candidate.length > 1 && /^["']/.test(candidate) && /["']$/.test(candidate)) {
        candidate = candidate.slice(1, -1);
      }
      if (/^["'<\uff08\u300c\u3010\u300a\u3014\u3008]/u.test(candidate)) candidate = candidate.slice(1);
      if (/>$/u.test(candidate)) candidate = candidate.slice(0, -1);
      if (/^file:\/\//i.test(candidate)) {
        var fromUri = decodeFileUri(candidate);
        if (fromUri !== null) candidate = fromUri;
      }
      candidate = stripLineSuffix(candidate);
      if (prose === true) candidate = proseCandidatePath(candidate);
      if (!/^(?:[A-Za-z]:[\\/]?|[\\/]{1,2})$/u.test(candidate)) candidate = candidate.replace(/[\\/]+$/u, "");
      /* Expand before validating, so every caller keeps the guarantee that a
         value leaving this layer is absolute while tilde chips stop being
         dropped on the floor. */
      candidate = expandHomePath(candidate);
      return looksAbsolute(candidate) ? candidate : null;
    }

    /** 正文里取出的路径：句读属于句子，不属于文件名。 */
    function proseCandidatePath(value) {
      return trimProsePunctuation(value.replace(/[.,;:!?，。；：！？、]+$/u, ""));
    }

    function looksAbsolute(value) {
      if (typeof value !== "string" || value === "") return false;
      if (value.charAt(0) === "/") return true;
      if (/^[A-Za-z]:[\\/]/.test(value)) return true;
      return /^\\\\[^\\]+\\[^\\]+/.test(value);
    }

    /** 只在能安全解码时解开百分号转义。 */
    function decodePercent(value) {
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    }

    /** Highest-confidence marker: the file route an inline link or image points at. */
    /**
     * One href → the path it names, plus how much the value itself claims to be
     * a path. `explicit` covers `?path=`, `file:` and other named params; a
     * same-origin page route is only a fallback, because for an attachment
     * `/attachments/x.png` is the page address, not a file on disk.
     */
    function hrefPath(href) {
      if (typeof href !== "string" || href === "") return null;
      var trimmed = href.trim();
      if (trimmed === "" || trimmed.charAt(0) === "#") return null;
      try {
        var url = new URL(trimmed, document.baseURI);
        /* 同源的 `?path=` 才是宿主的文件路由；外站链接里的 path 参数只是
           网址的一部分（`https://外站/open?path=/tmp/a.pdf` 不是本机文件）。 */
        if (url.origin === location.origin) {
          var fromQuery = normalizeCandidate(url.searchParams.get("path"));
          if (fromQuery !== null) return { path: fromQuery, explicit: true };
          var namedKeys = ["file", "filepath", "abs", "target"];
          for (var i = 0; i < namedKeys.length; i += 1) {
            var fromNamed = normalizeCandidate(url.searchParams.get(namedKeys[i]));
            if (fromNamed !== null) return { path: fromNamed, explicit: true };
          }
        }
        if (url.protocol === "file:") {
          var fromFile = decodeFileUri(trimmed);
          var normalized = fromFile === null ? null : normalizeCandidate(fromFile);
          return normalized === null ? null : { path: normalized, explicit: true };
        }
        /* 相对地址（`./a.md`、`docs/a.md`）与页面内锚点都不是本机文件；
           只剩以 `/` 开头的站内地址可能是宿主画出来的本地路径。 */
        if (trimmed.charAt(0) !== "/") return null;
        /* 尾斜杠说明指向目录，没有扩展名也接受；`a.cjs:12:3` 先剥行号。 */
        var served = stripLineSuffix(decodePercent(url.pathname));
        if (url.origin === location.origin && looksAbsolute(served) && (/\.[A-Za-z0-9]{1,6}$/.test(served) || /\/$/.test(served))) {
          var fromPathname = normalizeCandidate(served);
          return fromPathname === null ? null : { path: fromPathname, explicit: false };
        }
      } catch (error) {
        /* not a URL shape we handle */
      }
      return null;
    }

    function decodePathFromHref(href) {
      var found = hrefPath(href);
      return found === null ? null : found.path;
    }

    /**
     * Walk up from the clicked node looking for a link that names a file: href
     * first, then an absolute `data-*` value, then the reference chip title.
     */
    var PATH_ATTRS = ["href", "src"];

    /** JSON 里只认名字明确说「磁盘位置」的字段；`src`/`href` 多是页面地址。 */
    var JSON_PATH_KEYS = ["path", "absolutePath", "filePath", "localPath", "assetPath", "sourcePath"];

    /** 对象里带路径的字段（含容器与数组）：给 JSON 形状的 data-* 用。 */
    function pathFromPlainObject(box, depth) {
      if (box === null || typeof box !== "object" || depth > 2) return null;
      for (var k = 0; k < JSON_PATH_KEYS.length; k += 1) {
        var direct = normalizeCandidate(box[JSON_PATH_KEYS[k]]);
        if (direct !== null) return direct;
      }
      if (Array.isArray(box)) {
        for (var i = 0; i < box.length && i < 8; i += 1) {
          var fromItem = pathFromPlainObject(box[i], depth + 1);
          if (fromItem !== null) return fromItem;
        }
        return null;
      }
      for (var c = 0; c < PROP_CONTAINERS.length; c += 1) {
        var inner = pathFromPlainObject(box[PROP_CONTAINERS[c]], depth + 1);
        if (inner !== null) return inner;
      }
      return null;
    }

    /** `data-file='{"path":"/x"}'`：宿主把附件对象序列化进属性时也能认。 */
    function pathFromJsonAttr(value) {
      if (typeof value !== "string") return null;
      var text = value.trim();
      if (text === "" || text.length > 4000) return null;
      if (text.charAt(0) !== "{" && text.charAt(0) !== "[") return null;
      var box = null;
      try {
        box = JSON.parse(text);
      } catch (error) {
        return null;
      }
      return pathFromPlainObject(box, 0);
    }

    /** `data-*` values that may carry a path, in confidence order. */
    function datasetPath(node) {
      var dataset = node.dataset || {};
      var keys = Object.keys(dataset);
      for (var i = 0; i < keys.length; i += 1) {
        if (!/path|file|href|src|dir|folder|abs|attachment|asset/i.test(keys[i])) continue;
        var candidate = normalizeCandidate(dataset[keys[i]]);
        if (candidate !== null) return candidate;
        var fromJson = pathFromJsonAttr(dataset[keys[i]]);
        if (fromJson !== null) return fromJson;
      }
      return null;
    }

    /** An absolute path written as plain text inside the clicked element. */
    var proseCandidate = false;

    var PATH_IN_TEXT = /(?:^|[\s"'“”「」()（）\[\]<>])(@?"?(?:\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~\/(?!\/))[^\s"'“”「」<>，。；：！？（）【】《》]*)/u;

    /** 一段词像不像同一路径的下一段：不以分隔符或盘符开头，也不带句子标点。 */
    function continuesPath(word) {
      if (word === "" || /^[\/"'\u201c\u201d\u300c\u300d<>]/u.test(word)) return false;
      if (/^[A-Za-z]:/u.test(word)) return false;
      return true;
    }

    /**
     * `C:\Users\apple\Desktop\a b.md` 这类带空格的路径，正则只吃到第一个空格。
     * 往后最多接三段，逐段追加——跳过中间一段就会拼出另一条路径。
     */
    /** 往后看两段，判断中文词后面是否跟着文件名。 */
    function nextWordsLookLikeFile(rest) {
      var probe = rest;
      for (var round = 0; round < 2; round += 1) {
        var space = /^[ \t]+/u.exec(probe);
        if (space === null) return false;
        var word = /^[^ \t"'“”「」<>，。；：！？、（）【】《》]+/u.exec(probe.slice(space[0].length));
        if (word === null) return false;
        if (/\.[A-Za-z0-9]{1,8}$/u.test(word[0])) return true;
        probe = probe.slice(space[0].length + word[0].length);
      }
      return false;
    }

    function joinPathWords(text, rest) {
      var best = text;
      var remaining = rest;
      for (var round = 0; round < 3; round += 1) {
        var space = /^[ \t]+/u.exec(remaining);
        if (space === null) break;
        var word = /^[^ \t"'“”「」<>，。；：！？、（）【】《》]+/u.exec(remaining.slice(space[0].length));
        if (word === null) break;
        remaining = remaining.slice(space[0].length + word[0].length);
        if (!continuesPath(word[0])) break;
        /* 中文句子在路径后继续说话时，不要把后面的词吞进路径；
           但后两段里出现扩展名，说明中文词其实是文件名的一部分。 */
        if (/^[\u3400-\u9fff]+$/u.test(word[0]) && !/\.[A-Za-z0-9]{1,8}$/u.test(word[0]) && !nextWordsLookLikeFile(remaining)) break;
        best = best + " " + word[0];
      }
      return best;
    }

    /** 正文纯文本里，取光标落点所在的那段路径。 */
    function pathFromCaret(x, y) {
      if (typeof document.caretRangeFromPoint !== "function") return null;
      var range = null;
      try {
        range = document.caretRangeFromPoint(x, y);
      } catch (error) {
        return null;
      }
      if (range === null || range.startContainer === null || range.startContainer.nodeType !== 3) return null;
      var node = range.startContainer;
      var data = node.data;
      var offset = Math.min(range.startOffset, data.length);
      var lead = 0;
      for (var back = 0, walker = node; back < 2; back += 1) {
        walker = walker.previousSibling;
        if (walker === null || walker.nodeType !== 3) break;
        lead += walker.data.length;
      }
      if (lead > 0) {
        var merged = "";
        for (var step = 0, cursor = node; step < 2; step += 1) {
          cursor = cursor.previousSibling;
          if (cursor === null || cursor.nodeType !== 3) break;
          merged = cursor.data + merged;
        }
        data = merged + data;
        offset += lead;
      }
      var bounds = [];
      var matcher = new RegExp(PATH_IN_TEXT.source, "gu");
      var hit = null;
      while ((hit = matcher.exec(data)) !== null) {
        var captured = hit[1] === undefined ? hit[0] : hit[1];
        var start = hit.index + hit[0].length - captured.length;
        var joined = joinPathWords(captured, data.slice(start + captured.length));
        bounds.push({ text: joined, start: start, end: start + joined.length });
        if (hit[0].length === 0) matcher.lastIndex += 1;
      }
      for (var i = 0; i < bounds.length; i += 1) {
        if (offset >= bounds[i].start && offset <= bounds[i].end) return normalizeCandidate(bounds[i].text, true);
      }
      return null;
    }

    /** 节点上的内部属性键前缀。 */
    var FIBER_KEY = /^__(?:reactFiber|reactInternalInstance)\$/;

    /** 可能带文件的属性名。 */
    /* 磁盘字段与页面地址字段分开判：`src`/`href` 是页面地址，即使长得像
       绝对路径（`/attachments/a.png`）也不是本机文件。 */
    var PROP_DISK_KEYS = ["destination", "path", "absolutePath", "filePath", "localPath", "assetPath", "sourcePath"];
    var PROP_KEYS = PROP_DISK_KEYS.concat(["src", "href"]);
    var PROP_CONTAINERS = ["file", "asset", "attachment", "source", "item"];

    /** Strip the line suffix a Markdown file link carries (`path#L12`). */
    function stripLineSuffix(value) {
      if (typeof value !== "string") return value;
      var trimmed = value.replace(/#L[0-9]+(?:C[0-9]+)?(?:-L?[0-9]+)?(?::[0-9]+)?$/u, "");
      /* Windows 风格的 match:line 后缀（a.md:12）也当行号剥掉。 */
      return trimmed.replace(/(\.[A-Za-z0-9]{1,8}):[0-9]+(?::[0-9]+)?(?:-[0-9]+)?$/u, "$1");
    }

    /** Read the path a component's props carry, if any. */
    function propPath(box, key) {
      if (box === null || typeof box !== "object") return null;
      var value = box[key];
      if (PROP_DISK_KEYS.indexOf(key) >= 0) return normalizeCandidate(stripLineSuffix(value));
      var found = hrefPath(stripLineSuffix(value));
      return found !== null && found.explicit === true ? found.path : null;
    }

    function pathFromProps(props) {
      if (props === null || typeof props !== "object") return null;
      for (var c = 0; c < PROP_CONTAINERS.length; c += 1) {
        var box = props[PROP_CONTAINERS[c]];
        if (box === null || typeof box !== "object") continue;
        for (var k = 0; k < PROP_KEYS.length; k += 1) {
          var nested = propPath(box, PROP_KEYS[k]);
          if (nested !== null) return nested;
        }
      }
      for (var i = 0; i < PROP_KEYS.length; i += 1) {
        var fromProp = propPath(props, PROP_KEYS[i]);
        if (fromProp !== null) return fromProp;
      }
      return null;
    }

    /**
     * React file cards keep their path in the owning component's props, not in
     * the DOM: a Markdown image renders an icon and a file name only. Walk the
     * fiber chain up from the clicked node until a prop names a file.
     */
    function fiberOf(node) {
      for (var owner = node; owner !== null && owner !== undefined && owner !== document.body; owner = owner.parentElement) {
        if (owner.nodeType !== 1) continue;
        var keys = Object.keys(owner);
        for (var i = 0; i < keys.length; i += 1) {
          if (FIBER_KEY.test(keys[i])) return owner[keys[i]];
        }
      }
      return null;
    }

    function pathFromFiber(node) {
      var fiber = fiberOf(node);
      for (var depth = 0; fiber !== null && fiber !== undefined && depth < 24; depth += 1) {
        var found = pathFromProps(fiber.memoizedProps);
        if (found !== null) return found;
        fiber = fiber.return;
      }
      return null;
    }

    /** 组件自己知道这是个文件夹：appearance / isDirectory 之类的提示。 */
    function directoryHintFromProps(props) {
      if (props === null || typeof props !== "object") return undefined;
      var round = [props];
      var file = props.file;
      if (file !== null && typeof file === "object") round.push(file);
      var inner = props.reference;
      if (inner !== null && typeof inner === "object") round.push(inner);
      for (var i = 0; i < round.length; i += 1) {
        var item = round[i];
        if (item === null || typeof item !== "object") continue;
        if (item.appearance === "folder" || item.appearance === "directory") return true;
        if (item.appearance === "file") return false;
        if (item.isDirectory === true || item.directory === true) return true;
        if (item.isDirectory === false) return false;
      }
      return undefined;
    }

    function directoryHint(node) {
      for (var owner = node; owner !== null && owner !== undefined && owner !== document.body; owner = owner.parentElement) {
        if (owner.nodeType !== 1) continue;
        var attr = owner.getAttribute("data-appearance") || owner.getAttribute("data-type") || owner.getAttribute("data-kind");
        if (typeof attr === "string" && attr !== "") {
          var value = attr.toLowerCase();
          if (value === "folder" || value === "directory") return true;
          if (value === "file") return false;
        }
      }
      var fiber = fiberOf(node);
      for (var depth = 0; fiber !== null && fiber !== undefined && depth < 24; depth += 1) {
        var hint = directoryHintFromProps(fiber.memoizedProps);
        if (hint !== undefined) return hint;
        fiber = fiber.return;
      }
      return undefined;
    }

    /**
     * Walk up from the clicked node looking for a file link: href/src first, then
     * an absolute `data-*` value, then a title, then the element's own text. The
     * text pass covers paths the transcript renders as plain prose.
     */
    /** `srcset` 里挑一条：明确写出的磁盘位置优先，页面地址只当兜底。 */
    function srcsetCandidate(node) {
      var value = node.getAttribute("srcset");
      if (typeof value !== "string" || value === "") return null;
      var pieces = value.split(",");
      var fallback = null;
      for (var i = 0; i < pieces.length; i += 1) {
        var first = pieces[i].replace(/\s+\d+(?:\.\d+)?[wx]\s*$/u, "").trim();
        var found = hrefPath(first);
        if (found === null) continue;
        if (found.explicit === true) return found;
        if (fallback === null) fallback = found;
      }
      return fallback;
    }

    function srcsetPath(node) {
      var found = srcsetCandidate(node);
      return found === null ? null : found.path;
    }

    /** 右键落在图片上：图片自己就是被操作的对象。 */
    /** 站内相对地址补成绝对地址，复制出去才能直接打开。 */
    function absoluteUrl(value) {
      var text = String(value === null || value === undefined ? "" : value).trim();
      if (text === "") return null;
      if (/^https?:/i.test(text)) return text;
      if (/^\/\//u.test(text)) return String(location.protocol) + text;
      if (text.charAt(0) === "/") return String(location.origin) + text;
      return null;
    }

    /**
     * 右键落在链接上时，链接本身也是可操作对象。外层 `href` 优先：附件卡片里
     * 点的是预览图，真正要复制的那个地址在包着它的链接上。
     */
    function linkTarget(node) {
      for (var el = node; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        var href = absoluteUrl(el.getAttribute("href"));
        if (href !== null) return href;
      }
      for (var media = node; media !== null && media !== undefined && media !== document.body; media = media.parentElement) {
        if (media.nodeType !== 1) continue;
        if (media.tagName === "IMG" || media.tagName === "VIDEO" || media.tagName === "AUDIO" || media.tagName === "SOURCE") {
          var source = absoluteUrl(media.currentSrc || media.getAttribute("src"));
          if (source !== null) return source;
        }
      }
      return null;
    }

    /** 包着图片的那层链接（附件卡片）：只认 <a href>，不拿图片地址冒充。 */
    function outerLinkHref(node) {
      for (var el = node; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        var href = absoluteUrl(el.getAttribute("href"));
        if (href !== null) return href;
      }
      return null;
    }

    function imageTarget(node) {
      for (var el = node; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        if (el.tagName === "IMG") return el;
      }
      return null;
    }

    function imageSource(image) {
      var source = image.currentSrc || image.getAttribute("src") || "";
      return source === "" ? null : String(source);
    }

    /**
     * 图片在磁盘上的位置：只认明确的来源（file:// 或 data-* / title），
     * 不把 `/attachments/...` 这类页面地址当成文件路径。
     */
    function imageFilePath(image) {
      for (var el = image; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        var source = el.getAttribute("src");
        if (source !== null && /^file:/i.test(source)) {
          var decoded = decodePathFromHref(source);
          if (decoded !== null) return decoded;
        }
        var dataset = el.dataset || {};
        var keys = Object.keys(dataset);
        for (var i = 0; i < keys.length; i += 1) {
          if (!/path|file|href|src|dir|folder|abs/i.test(keys[i])) continue;
          var candidate = normalizeCandidate(dataset[keys[i]]);
          if (candidate !== null && looksAbsolute(candidate)) return candidate;
        }
        var title = normalizeCandidate(el.getAttribute("title"));
        if (title !== null && looksAbsolute(title)) return title;
        var alt = normalizeCandidate(el.getAttribute("alt"));
        if (alt !== null && looksAbsolute(alt)) return alt;
      }
      return null;
    }

    /**
     * 对话里的附件卡片：视频/文件被收成一张卡时，DOM 里只有文件名，
     * 既没有 href 也没有地址。先认卡片上的名字，再回同一条消息正文里找同名绝对路径。
     */
    var CARD_CLASS = /(?:file|media|attachment)[-_]?card|card[-_]?(?:file|media|attachment)/i;

    function attachmentCard(node) {
      for (var el = node; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        var className = el.className;
        if (typeof className === "string" && CARD_CLASS.test(className)) return el;
      }
      return null;
    }

    function plainLabel(value) {
      if (typeof value !== "string") return null;
      var text = value.replace(/^[\s"'@]+/u, "").replace(/["'\s]+$/u, "");
      return text === "" ? null : text;
    }

    function baseNameOf(value) {
      var text = String(value).replace(/[\\/]+$/u, "");
      var cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
      return cut === -1 ? text : text.slice(cut + 1);
    }

    /** 卡片上写的文件名：title 优先，其次名称那一行的文字。 */
    function cardFileName(card) {
      var title = plainLabel(card.getAttribute("title"));
      if (title !== null) return title;
      var children = card.children || [];
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (child === null || child === undefined || child.nodeType !== 1) continue;
        if (!/name|title|caption|label/i.test(String(child.className || ""))) continue;
        var label = plainLabel(child.textContent);
        if (label !== null) return label;
      }
      return plainLabel(card.textContent);
    }

    /** 消息边界：同名文件只在本条消息里找，不跨到相邻消息去。 */
    function messageRoot(node) {
      for (var el = node; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        if (typeof el.hasAttribute === "function" && el.hasAttribute("data-message-id")) return el;
        var className = typeof el.className === "string" ? el.className : "";
        if (/(?:^|[-_ ])message(?:[-_ ]|$)/i.test(className)) return el;
        if (el.getAttribute("role") === "listitem" && el.parentElement !== null && el.parentElement !== document.body) {
          var parentClass = typeof el.parentElement.className === "string" ? el.parentElement.className : "";
          if (/message|turn|conversation/i.test(parentClass)) return el;
        }
      }
      return null;
    }

    /**
     * 同一条消息里文件名对得上的绝对路径。对不上、或同名的有好几个不同
     * 路径时返回 null：宁可让人自己选，也不能把相邻消息的文件当成这一个。
     */
    function pathForCardName(card, name) {
      if (name === null || name === undefined) return null;
      var wanted = String(name).toLowerCase();
      var bound = messageRoot(card);
      var scope = card;
      var hits = [];
      var note = function (candidate) {
        if (candidate === null || candidate === undefined) return;
        if (baseNameOf(candidate).toLowerCase() !== wanted) return;
        if (hits.indexOf(candidate) === -1) hits.push(candidate);
      };
      for (var depth = 0; depth < 8 && scope !== null && scope !== undefined && scope !== document.body; depth += 1) {
        if (typeof scope.querySelectorAll === "function") {
          var links = null;
          try { links = scope.querySelectorAll("a[href]"); } catch (ignored) { links = null; }
          if (links !== null) {
            for (var link = 0; link < links.length && link < 200; link += 1) {
              var linkPath = null;
              try { linkPath = pathFromNode(links[link], null); } catch (ignored) { linkPath = null; }
              note(linkPath);
            }
          }
        }
        var text = typeof scope.textContent === "string" ? scope.textContent : "";
        if (text !== "" && text.length <= 20000) {
          var matcher = new RegExp(PATH_IN_TEXT.source, "gu");
          var hit = null;
          while ((hit = matcher.exec(text)) !== null) {
            var captured = hit[1] === undefined ? hit[0] : hit[1];
            var tail = text.slice(hit.index + hit[0].length);
            var joined = joinPathWords(captured, tail);
            note(normalizeCandidate(joined.replace(/[)\]}>、。；：！？,;"'“”‘’]+$/u, ""), false));
            /* 一行里并列写了两条路径时正则可能整段匹配，joinPathWords 只留
               后一条；逐词再看一遍，两条都算候选，才判得出「同名不猜」。 */
            var pieces = captured.split(/\s+/u);
            for (var piece = 0; piece < pieces.length; piece += 1) {
              note(normalizeCandidate(pieces[piece].replace(/[)\]}>、。；：！？,;"'“”‘’]+$/u, ""), false));
            }
            if (hit[0].length === 0) matcher.lastIndex += 1;
          }
        }
        if (bound !== null && scope === bound) break;
        scope = scope.parentElement;
      }
      return hits.length === 1 ? hits[0] : null;
    }

    /**
     * 剪贴板图片只认 PNG：webp/jpeg 的附件先画到 canvas 转 PNG，
     * 转不了就交回原始 blob 让调用方按原类型再试一次。
     */
    function toPngBlob(blob) {
      if (blob.type === "image/png") return Promise.resolve(blob);
      if (typeof createImageBitmap !== "function" || typeof document === "undefined") return Promise.reject(new Error("no-decode"));
      return createImageBitmap(blob).then(function (bitmap) {
        var canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        var context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (context === null) throw new Error("no-canvas");
        context.drawImage(bitmap, 0, 0);
        if (typeof bitmap.close === "function") bitmap.close();
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (png) {
            if (png === null || png === undefined) reject(new Error("no-png"));
            else resolve(png);
          }, "image/png");
        });
      });
    }

    /** 图片进剪贴板：粘贴出来就是图片，不再是那串文件名。 */
    function copyImage(source) {
      var request = typeof fetch === "function" ? fetch(source, { credentials: "include" }) : Promise.reject(new Error("no fetch"));
      request.then(function (response) {
        if (response.ok !== true) throw new Error("status " + response.status);
        return response.blob();
      }).then(function (blob) {
        var original = blob.type === "" ? "image/png" : blob.type;
        return toPngBlob(blob).then(function (png) {
          return { type: "image/png", data: png };
        }, function () {
          return { type: original, data: blob };
        });
      }).then(function (ready) {
        return navigator.clipboard.write([new ClipboardItem({ [ready.type]: ready.data })]);
      }).then(function () {
        toast(strings().copiedImage);
      }, function (error) {
        report("copy-image-failed " + String((error && error.message) || error));
        toast(strings().clipboardFailed);
      });
    }

    function pathFromNode(start, point) {
      var routePath = null;
      for (var node = start; node !== null && node !== undefined && node !== document.body; node = node.parentElement) {
        if (node.nodeType !== 1) continue;
        for (var a = 0; a < PATH_ATTRS.length; a += 1) {
          var found = hrefPath(node.getAttribute(PATH_ATTRS[a]));
          if (found === null) continue;
          if (found.explicit === true) return found.path;
          if (routePath === null) routePath = found.path;
        }
        var fromSrcset = srcsetCandidate(node);
        if (fromSrcset !== null) {
          if (fromSrcset.explicit === true) return fromSrcset.path;
          if (routePath === null) routePath = fromSrcset.path;
        }
        var fromData = datasetPath(node);
        if (fromData !== null) return fromData;
        var fromTitle = normalizeCandidate(node.getAttribute("title"));
        if (fromTitle !== null) return fromTitle;
        var fromLabel = normalizeCandidate(node.getAttribute("aria-label"));
        if (fromLabel !== null) return fromLabel;
        if (node.tagName === "IMG") {
          var fromAlt = normalizeCandidate(node.getAttribute("alt"));
          if (fromAlt !== null) return fromAlt;
        }
      }
      var fromFiber = pathFromFiber(start);
      if (fromFiber !== null) return fromFiber;
      if (routePath !== null && !(point !== null && point !== undefined && point.strict === true)) return routePath;
      if (point !== null && point !== undefined && point.allowProse !== false && point.strict !== true) {
        var fromCaret = pathFromCaret(point.x, point.y);
        if (fromCaret !== null) {
          proseCandidate = true;
          return fromCaret;
        }
      }
      return null;
    }

    /* ── wording ────────────────────────────────────────────────────────── */

    /* ── menu styling: project tokens only, no new palette ──────────────── */

    var STYLE_ID = "dsh-chat-link-actions-style";
    var CSS_EXTRA = [
      ".dcla-editor{position:fixed;z-index:1101;pointer-events:auto;box-sizing:border-box;padding:16px;min-width:470px;",
      "max-width:min(680px,calc(100vw - 32px));background:var(--dsw-specific-menu,rgba(30,32,38,.96));",
      "backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "color:var(--dsw-alias-label-primary,#f2f3f5);border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.3));",
      "font:var(--dsw-font-sm-14,14px)/1.6 var(--dsw-font-family,system-ui),-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;}",
      ".dcla-rows{display:flex;flex-direction:column;gap:10px;max-height:58vh;overflow:auto;}",
      ".dcla-edit-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;",
      "border:1px solid rgba(127,127,127,.18);border-radius:var(--dsw-radius-lg,12px);}",
      ".dcla-field{box-sizing:border-box;min-width:0;padding:6px 9px;border-radius:var(--dsw-radius-md,8px);",
      "border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.10);color:inherit;font:inherit;",
      "font-size:var(--dsw-font-xs-13,13px);}",
      ".dcla-edit-row .dcla-name{flex:1 1 100%;}",
      ".dcla-edit-row .dcla-value{flex:1 1 100%;}",
      ".dcla-pick{display:inline-flex;align-items:center;gap:6px;max-width:210px;padding:6px 10px;",
      "border-radius:var(--dsw-radius-md,8px);border:1px solid rgba(127,127,127,.34);background:transparent;",
      "color:inherit;font:inherit;font-size:var(--dsw-font-xs-13,13px);cursor:pointer;white-space:nowrap;overflow:hidden;}",
      ".dcla-pick[data-open=true]{background:rgba(127,127,127,.16);}",
      ".dcla-caret{flex:none;width:0;height:0;opacity:.55;border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid currentColor;}",
      ".dcla-drop{margin-left:auto;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid transparent;",
      "background:transparent;color:inherit;font:inherit;font-size:var(--dsw-font-xs-13,13px);cursor:pointer;opacity:.7;}",
      ".dcla-drop:hover{opacity:1;background:rgba(127,127,127,.14);}",
      ".dcla-pick-menu{z-index:1102;min-width:120px;animation:none;}",
      ".dcla-pick-menu .dcla-check{flex:none;width:14px;opacity:0;font-size:var(--dsw-font-xxs-12,12px);}",
      ".dcla-pick-menu .dcla-check[data-on=true]{opacity:.9;}",
      ".dcla-editor-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;}",
      ".dcla-editor-row button{box-sizing:border-box;padding:6px 14px;border-radius:var(--dsw-radius-md,8px);",
      "border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;font:inherit;",
      "font-size:var(--dsw-font-xs-13,13px);cursor:pointer;}",
      ".dcla-editor-row button[data-primary=\"true\"]{background:rgba(127,127,127,.22);border-color:transparent;}",
      ".dcla-editor-row button[data-add=\"true\"]{margin-right:auto;}"
    ].join("");
    var CSS = [
      ".dcla-layer{position:fixed;inset:0;z-index:1100;pointer-events:none;}",
      ".dcla-menu{position:fixed;z-index:1100;pointer-events:auto;box-sizing:border-box;padding:6px;min-width:200px;",
      "max-width:min(320px,calc(100vw - 24px));background:var(--dsw-specific-menu,rgba(30,32,38,.96));",
      "backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(180%));",
      "border:1px solid var(--dsw-elevation-stroke-color,rgba(255,255,255,.08));",
      "border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.4));",
      "font-family:var(--dsw-font-family,system-ui),-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;",
      "font-size:var(--dsw-font-xs-13,13px);line-height:20px;",
      "color:var(--dsw-alias-label-primary,#f2f3f5);user-select:none;-webkit-user-select:none;}",
      ".dcla-path{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary,rgba(242,243,245,.45));",
      "font-size:var(--dsw-font-xxs-12,12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}",
      ".dcla-sep{height:1px;margin:2px 6px 6px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));}",
      ".dcla-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;",
      "border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;",
      "text-align:left;cursor:default;white-space:nowrap;overflow:hidden;}",
      ".dcla-item[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));}",
      ".dcla-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4c8dff);outline-offset:-1px;}",
      ".dcla-glyph{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;",
      "color:var(--dsw-alias-label-secondary,rgba(242,243,245,.65));}",
      ".dcla-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;}",
      ".dcla-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1100;",
      "padding:6px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-elevation-panel,rgba(30,32,38,.96));",
      "border:1px solid var(--dsw-elevation-stroke-color,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f3f5);",
      "font:inherit;font-size:var(--dsw-font-xs-13,13px);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.3));}",
      "@media (prefers-reduced-motion:no-preference){.dcla-menu{animation:dcla-in 90ms ease-out;}}",
      "@keyframes dcla-in{from{opacity:0;transform:translateY(-2px);}to{opacity:1;transform:none;}}"
    ].join("");

    /** 界面语言跟着宿主走：宿主把当前语言写在 <html lang> 上。 */  // ui-copy-ignore
    var TEXT = {
      zh: {  // ui-copy-ignore
        menu: "文件操作",  // ui-copy-ignore
        quote: "引用到对话",  // ui-copy-ignore
        reveal: "在文件管理器中查看",  // ui-copy-ignore
        copy: "复制路径",  // ui-copy-ignore
        copiedPath: "已复制路径",  // ui-copy-ignore
        copiedQuote: "已复制引用",  // ui-copy-ignore
        missing: "目标文件不存在",  // ui-copy-ignore
        quoteFailed: "当前会话无法插入引用",
        revealPending: "已请求打开，窗口可能稍后出现",
        managerFailed: "无法打开文件管理器",
        menuFailed: "菜单没能打开，再试一次",
        clipboardFailed: "剪贴板不可用",  // ui-copy-ignore
        actionNeedsFile: "这个入口只对文件生效",
        copyImage: "复制图片",  // ui-copy-ignore
        imageCaption: "图片",
        copyLink: "复制链接",  // ui-copy-ignore
        copiedLink: "已复制链接",  // ui-copy-ignore
        copyName: "复制文件名",  // ui-copy-ignore
        copiedName: "已复制文件名",  // ui-copy-ignore
        customize: "自定义入口…",  // ui-copy-ignore
        share: "发送到…",  // ui-copy-ignore
        shareFailed: "这台机器打不开系统分享",  // ui-copy-ignore
        customizeTitle: "自定义入口",  // ui-copy-ignore
        valueHints: { shell: "命令，{path} 代表文件", powershell: "命令，{path} 代表文件", pwsh: "命令，{path} 代表文件", app: "App 名字或路径", url: "链接，可用 {url}", share: "", shortcut: "快捷指令名字", service: "服务名" },  // ui-copy-ignore
        scopeLabel: "适用于",  // ui-copy-ignore
        purposeLabel: "用途",  // ui-copy-ignore
        scopeWords: { all: "通用", video: "视频", audio: "音频", image: "图片", document: "文档", archive: "压缩包", code: "代码" },  // ui-copy-ignore
        kindWords: { shell: "命令", powershell: "PowerShell 5", pwsh: "PowerShell 7", app: "打开方式", shortcut: "快捷指令", url: "链接", share: "系统分享", service: "分享服务" },  // ui-copy-ignore
        addKindEntry: "新增{kind}入口…",  // ui-copy-ignore
        addRow: "添加一行",  // ui-copy-ignore
        removeRow: "删除",  // ui-copy-ignore
        namePlaceholder: "名称",  // ui-copy-ignore
        valuePlaceholder: "命令或应用；可用 {path} {dir} {name} {url}",  // ui-copy-ignore
        save: "保存",  // ui-copy-ignore
        cancel: "取消",  // ui-copy-ignore
        saved: "已保存",
        saveFailed: "没能保存，再试一次",
        copiedImage: "已复制图片"  // ui-copy-ignore
      },
      en: {  // ui-copy-ignore
        menu: "File actions",  // ui-copy-ignore
        quote: "Quote in chat",  // ui-copy-ignore
        reveal: "Show in file manager",  // ui-copy-ignore
        copy: "Copy path",  // ui-copy-ignore
        copiedPath: "Path copied",  // ui-copy-ignore
        copiedQuote: "Reference copied",  // ui-copy-ignore
        missing: "File not found",  // ui-copy-ignore
        quoteFailed: "This conversation cannot take the reference",
        revealPending: "Open requested; the window may appear shortly",
        managerFailed: "Could not open the file manager",
        menuFailed: "Menu did not open; try again",
        clipboardFailed: "Clipboard unavailable",
        actionNeedsFile: "This action needs a file",
        copyImage: "Copy image",  // ui-copy-ignore
        imageCaption: "Image",
        copyLink: "Copy link",  // ui-copy-ignore
        copiedLink: "Link copied",  // ui-copy-ignore
        copyName: "Copy file name",  // ui-copy-ignore
        copiedName: "File name copied",  // ui-copy-ignore
        customize: "Customize actions…",  // ui-copy-ignore
        share: "Send to…",  // ui-copy-ignore
        shareFailed: "System share is unavailable here",  // ui-copy-ignore
        customizeTitle: "Custom actions",  // ui-copy-ignore
        valueHints: { shell: "Command; {path} is the file", powershell: "Command; {path} is the file", pwsh: "Command; {path} is the file", app: "App name or path", url: "Link; {url} is the file URL", share: "", shortcut: "Shortcut name", service: "Service name" },  // ui-copy-ignore
        scopeLabel: "Applies to",  // ui-copy-ignore
        purposeLabel: "Purpose",  // ui-copy-ignore
        scopeWords: { all: "All files", video: "Video", audio: "Audio", image: "Image", document: "Document", archive: "Archive", code: "Code" },  // ui-copy-ignore
        kindWords: { shell: "Command", powershell: "PowerShell 5", pwsh: "PowerShell 7", app: "Application", shortcut: "Shortcut", url: "Link", share: "System share", service: "Share service" },  // ui-copy-ignore
        addKindEntry: "New {kind} action…",  // ui-copy-ignore
        addRow: "Add row",  // ui-copy-ignore
        removeRow: "Remove",  // ui-copy-ignore
        namePlaceholder: "Name",  // ui-copy-ignore
        valuePlaceholder: "Command or app; {path} {dir} {name} {url}",  // ui-copy-ignore
        save: "Save",  // ui-copy-ignore
        cancel: "Cancel",  // ui-copy-ignore
        saved: "Saved",
        saveFailed: "Could not save, try again",
        copiedImage: "Image copied"  // ui-copy-ignore  // ui-copy-ignore
      }
    };

    function strings() {
      var element = document.documentElement;
      var lang = element === null ? "" : element.getAttribute("lang");
      var tag = typeof lang === "string" && lang !== "" ? lang : (typeof navigator === "undefined" ? "" : navigator.language);
      return /^zh/i.test(String(tag === null || tag === undefined ? "" : tag)) ? TEXT.zh : TEXT.en;
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS + CSS_EXTRA;
      document.head.appendChild(style);
    }

    /* ── icons: 16px outline, currentColor ──────────────────────────────── */

    var ICONS = {
      quote: ["M2.5 4.5h11M2.5 8h7M2.5 11.5h9"],
      reveal: ["M2 5.7A1.6 1.6 0 0 1 3.6 4.1h2.2l1.2 1.5h4.6A1.6 1.6 0 0 1 13.2 7.2v4.6A1.6 1.6 0 0 1 11.6 13.4h-8A1.6 1.6 0 0 1 2 11.8V5.7Z"],
      image: ["M2.4 3.6h11.2v8.8H2.4z", "M2.4 10.6l3.2-3 2.6 2.4 2.2-2 3.2 3"],
      custom: ["M8 2.6v10.8M2.6 8h10.8"],
      copy: ["M5.6 5.6h6.8v6.8H5.6z", "M10.4 5.6V4.2A1.6 1.6 0 0 0 8.8 2.6H4.2A1.6 1.6 0 0 0 2.6 4.2v4.6A1.6 1.6 0 0 0 4.2 10.4h1.4"],
      share: ["M8 2.4v7.2", "M5.2 5.2 8 2.4l2.8 2.8", "M3.9 7.6H2.6v6h10.8v-6h-1.3"]
    };

    function icon(name) {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "none");
      svg.setAttribute("aria-hidden", "true");
      var paths = ICONS[name] || [];
      for (var i = 0; i < paths.length; i += 1) {
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", paths[i]);
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.3");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      }
      return svg;
    }

    /* ── menu ───────────────────────────────────────────────────────────── */

    var open = null;

    function closeMenu(restoreFocus) {
      if (open === null) return;
      var state = open;
      open = null;
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("contextmenu", onContextDuringMenu, true);
      window.removeEventListener("resize", onViewportChange, true);
      window.removeEventListener("scroll", onViewportChange, true);
      if (state.layer.parentNode !== null) state.layer.parentNode.removeChild(state.layer);
      if (restoreFocus === true && state.restoreFocus !== null && document.contains(state.restoreFocus)) {
        state.restoreFocus.focus({ preventScroll: true });
      }
    }

    function onPointerDown(event) {
      if (open === null || open.layer.contains(event.target)) return;
      closeMenu(false);
    }

    function onContextDuringMenu(event) {
      if (open !== null && open.layer.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function onKeyDown(event) {
      if (open === null) return;
      var typing = editableField(event.target) === true || (open.restoreFocus !== null && editableField(open.restoreFocus) === true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (typing && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        /* 用户已经在打字，就当放弃了菜单，别抢键。 */
        closeMenu(false);
        return;
      }
      if (event.key === "Tab") {
        closeMenu(false);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        open.index = event.key === "Home" ? 0 : open.items.length - 1;
        paintActive();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        var count = open.items.length;
        var step = event.key === "ArrowDown" ? 1 : -1;
        open.index = ((open.index + step) % count + count) % count;
        paintActive();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        var item = open.items[open.index];
        if (item === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu(false);
        item.run();
      }
    }

    function onViewportChange() {
      if (open === null) return;
      placeMenu(open.panel, open.x, open.y);
    }

    /** Place the panel at the pointer, flipped inward at the viewport edges. */
    function placeMenu(panel, x, y) {
      var margin = 8;
      var rect = panel.getBoundingClientRect();
      var left = x;
      var top = y;
      if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, x - rect.width);
      if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height);
      panel.style.left = Math.round(left) + "px";
      panel.style.top = Math.round(top) + "px";
    }

    function paintActive() {
      if (open === null) return;
      for (var i = 0; i < open.buttons.length; i += 1) {
        open.buttons[i].setAttribute("data-active", i === open.index ? "true" : "false");
      }
      var active = open.buttons[open.index];
      if (active !== undefined) open.panel.setAttribute("aria-activedescendant", active.id);
    }

    function buildMenu(captionText, items) {
      var panel = document.createElement("div");
      panel.className = "dcla-menu";
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", strings().menu);
      panel.setAttribute("aria-activedescendant", "dcla-item-0");

      if (captionText !== null && captionText !== undefined && captionText !== "") {
        var caption = document.createElement("div");
        caption.className = "dcla-path";
        caption.title = captionText;
        caption.textContent = captionText;
        panel.appendChild(caption);

        var separator = document.createElement("div");
        separator.className = "dcla-sep";
        panel.appendChild(separator);
      }

      var buttons = [];
      items.forEach(function (item, position) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "dcla-item";
        button.id = "dcla-item-" + position;
        button.setAttribute("role", "menuitem");
        button.setAttribute("tabindex", "-1");
        button.setAttribute("data-active", position === 0 ? "true" : "false");

        var glyph = document.createElement("span");
        glyph.className = "dcla-glyph";
        glyph.appendChild(icon(item.icon));
        button.appendChild(glyph);

        var label = document.createElement("span");
        label.className = "dcla-label";
        label.textContent = item.label;
        button.appendChild(label);

        button.addEventListener("mouseenter", function () {
          if (open === null) return;
          open.index = position;
          paintActive();
        });
        button.addEventListener("click", function () {
          report("menu-click " + item.id);
          closeMenu(false);
          try {
            item.run();
          } catch (error) {
            report("run-threw " + item.id + " " + String((error && error.message) || error));
            toast(strings().managerFailed);
          }
        });
        panel.appendChild(button);
        buttons.push(button);
      });

      return { panel: panel, buttons: buttons };
    }

    /* ── 自定义入口 ─────────────────────────────────────────────────────── */

    var customActions = [];
    var customLoaded = false;
    /** Home published by actions-get, used to expand a tilde path into a real one. */
    var homePath = null;

    /**
     * `~` / `~/x` → an absolute path under home, using home's own
     * separator so a Windows home never comes out as `C:\a/.dsh/x`.
     * Until actions-get lands the value is returned untouched, which makes the
     * caller's absolute check reject it — the same "nothing happens" this fix
     * removes, but only for the first few milliseconds after the plugin mounts.
     */
    function expandHomePath(value) {
      if (typeof value !== "string" || value === "") return value;
      if (value !== "~" && value.charAt(0) !== "~") return value;
      if (value !== "~" && value.charAt(1) !== "/" && value.charAt(1) !== "\\") return value;
      if (homePath === null) return value;
      var base = homePath.replace(/[\\/]+$/u, "");
      if (value === "~") return base;
      var separator = base.indexOf("\\") !== -1 && base.indexOf("/") === -1 ? "\\" : "/";
      var rest = value.slice(2).replace(/[\\/]+/gu, separator);
      return rest === "" ? base : base + separator + rest;
    }

    function routeUrl(action) {
      return "/chat-link-actions?action=" + encodeURIComponent(action);
    }

    function postJson(action, body) {
      return fetch(routeUrl(action), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body)
      }).then(function (response) {
        return response.json();
      }).then(function (data) {
        if (data === null || data === undefined || data.ok !== true) {
          throw new Error(String((data && data.error) || "bad-response"));
        }
        return data;
      });
    }

    function refreshCustomActions() {
      postJson("actions-get").then(function (data) {
        var next = Array.isArray(data.actions) ? data.actions : [];
        var changed = JSON.stringify(next) !== JSON.stringify(customActions);
        customActions = next;
        customLoaded = true;
        if (typeof data.home === "string" && data.home !== "") homePath = data.home;
        if (changed) report("actions-loaded " + String(customActions.length));
      }, function (error) {
        customLoaded = true;
        report("actions-get-failed " + String((error && error.message) || error));
      });
    }

    function customFailureText(error, words) {
      var text = words || strings();
      var code = String((error && error.message) || error);
      if (code.indexOf("needs-file") !== -1) return text.actionNeedsFile;
      return text.managerFailed;
    }

    function runCustom(entry, target) {
      postJson("actions-run", { label: entry.label, scope: entry.scope || "all", path: target.path || "", url: target.url || "" }).then(function () {
        closeMenu(false);
      }, function (error) {
        report("action-failed " + entry.label + " " + String((error && error.message) || error));
        toast(customFailureText(error));
      });
    }

    /** 面板开着的时候，用户点界面任何地方就把它收掉。 */
    var shareWatcher = null;
    function watchShareDismiss() {
      stopShareDismiss();
      var fired = false;
      var kill = function () {
        if (fired) return;
        fired = true;
        stopShareDismiss();
        postJson("share-cancel", {}).catch(function () {});
      };
      var onDown = function () { kill(); };
      var onBlur = function () { kill(); };
      shareWatcher = function () {
        document.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("blur", onBlur);
        shareWatcher = null;
      };
      document.addEventListener("pointerdown", onDown, true);
      window.addEventListener("blur", onBlur);
      setTimeout(function () { if (shareWatcher !== null) stopShareDismiss(); }, 120000);
    }
    function stopShareDismiss() {
      if (shareWatcher !== null) shareWatcher();
    }

    function runShare(path) {
      postJson("actions-run", { label: "", kind: "share", path: path, url: "" }).then(function () {
        closeMenu(false);
        watchShareDismiss();
      }, function (error) {
        report("share-failed " + String((error && error.message) || error));
        toast(strings().shareFailed);
      });
    }

    /** 文件后缀归到哪一类：mkv/mp4 都是视频，一个入口管一整类。 */
    var FILE_KINDS = [
      ["video", "mp4 mkv mov avi webm m4v mpg mpeg ts flv wmv 3gp"],
      ["audio", "mp3 wav flac aac m4a ogg opus aiff wma amr"],
      ["image", "png jpg jpeg gif webp bmp svg heic heif tif tiff avif ico"],
      ["document", "pdf doc docx xls xlsx ppt pptx md txt rtf pages numbers key epub csv"],
      ["archive", "zip rar 7z tar gz bz2 xz tgz dmg iso pkg"],
      ["code", "js mjs cjs jsx ts tsx py rb go rs java c h cpp hpp cs sh bash zsh swift kt php css scss html htm json yml yaml toml xml sql ipynb"]
    ];
    var EXT_KIND = {};
    FILE_KINDS.forEach(function (pair) {
      String(pair[1]).split(" ").forEach(function (ext) {
        if (ext !== "") EXT_KIND[ext] = pair[0];
      });
    });

    /** 文件名 → 类别；认不出就是 null，只拿通用入口。 */
    function kindOfName(value) {
      if (value === null || value === undefined) return null;
      var name = baseNameOf(String(value));
      var dot = name.lastIndexOf(".");
      if (dot <= 0 || dot === name.length - 1) return null;
      var ext = name.slice(dot + 1).toLowerCase();
      return EXT_KIND[ext] === undefined ? null : EXT_KIND[ext];
    }

    function kindOfTarget(target) {
      if (target === null || target === undefined) return null;
      var fromPath = kindOfName(target.path);
      return fromPath === null ? kindOfName(target.name) : fromPath;
    }

    /** 通用入口人人有；限定入口只给同一类的文件。 */
    function menuEntriesFor(entries, target) {
      var kind = kindOfTarget(target);
      return entries.filter(function (entry) {
        var scope = entry === null || entry === undefined || entry.scope === undefined ? "all" : String(entry.scope);
        return scope === "all" || (kind !== null && scope === kind);
      });
    }

    function customMenuItems(target) {
      if (!customLoaded) refreshCustomActions();
      return menuEntriesFor(customActions, target).map(function (entry) {
        return { id: "custom:" + entry.label, label: entry.label, icon: "custom", run: function () {
          runCustom(entry, target);
        } };
      });
    }


    var SCOPE_ORDER = ["all", "video", "audio", "image", "document", "archive", "code"];
    var PURPOSE_ORDER = ["app", "shell", "powershell", "pwsh", "url", "share", "shortcut", "service"];

    /**
     * 下拉框的当前值：清单里没有的 kind 也要原样留着。旧实现把不认识的值
     * 一律改成 keys[0]，于是「打开编辑器再原样保存」把 powershell 写成了 app。
     */
    function pickerCurrent(value, keys) {
      if (value === undefined || value === null || String(value) === "") return keys[0];
      return String(value);
    }

    /** 下拉用菜单样式，别落到系统原生列表。 */
    function editorPicker(className, label, keys, words, value) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "dcla-pick " + className;
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-label", label);
      var current = pickerCurrent(value, keys);
      var text = document.createElement("span");
      var caret = document.createElement("span");
      caret.className = "dcla-caret";
      button.appendChild(text);
      button.appendChild(caret);

      var box = null;
      var listening = false;
      var closeBox = function () {
        if (box !== null && box.parentNode !== null) box.parentNode.removeChild(box);
        box = null;
        button.setAttribute("data-open", "false");
        if (listening) {
          document.removeEventListener("pointerdown", onDocDown, true);
          listening = false;
        }
      };
      var onDocDown = function (event) {
        if (box === null) return;
        var target = event.target;
        if (box.contains(target) || button.contains(target)) return;
        closeBox();
      };
      var paint = function () {
        text.textContent = words[current] === undefined ? current : words[current];
        button.value = current;
        button.setAttribute("aria-label", label + "：" + text.textContent);  // ui-copy-ignore
      };
      var choose = function (key) {
        current = key;
        paint();
        closeBox();
        if (typeof button.onChange === "function") button.onChange(key);
      };
      paint();

      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (box !== null) {
          closeBox();
          return;
        }
        box = document.createElement("div");
        box.className = "dcla-menu dcla-pick-menu";
        box.setAttribute("role", "listbox");
        box.setAttribute("aria-label", label);
        keys.forEach(function (key) {
          var item = document.createElement("button");
          item.type = "button";
          item.className = "dcla-item";
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", key === current ? "true" : "false");
          var check = document.createElement("span");
          check.className = "dcla-check";
          check.textContent = "\u2713";
          check.setAttribute("data-on", key === current ? "true" : "false");
          item.appendChild(check);
          var word = document.createElement("span");
          word.className = "dcla-label";
          word.textContent = words[key] === undefined ? key : words[key];
          item.appendChild(word);
          item.addEventListener("click", function (clickEvent) {
            clickEvent.stopPropagation();
            choose(key);
            button.focus();
          });
          box.appendChild(item);
        });
        document.body.appendChild(box);
        var rect = button.getBoundingClientRect();
        placeMenu(box, rect.left, rect.bottom + 4);
        button.setAttribute("data-open", "true");
        if (!listening) {
          document.addEventListener("pointerdown", onDocDown, true);
          listening = true;
        }
      });
      button.dismiss = closeBox;
      return button;
    }

    function editorInput(className, placeholder, value) {
      var input = document.createElement("input");
      input.type = "text";
      input.className = "dcla-field " + className;
      input.setAttribute("placeholder", placeholder);
      input.value = value === undefined || value === null ? "" : String(value);
      return input;
    }

    /** 编辑界面：一条入口一张小卡，能选通用或限定到某一类；保存后立刻出现在右键里。 */
    function openActionsEditor(presetScope) {
      closeMenu(false);
      ensureStyle();
      var zh = strings();
      var layer = document.createElement("div");
      layer.className = "dcla-layer";
      layer.style.pointerEvents = "auto";

      var panel = document.createElement("div");
      panel.className = "dcla-editor";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", zh.customizeTitle);

      var rows = document.createElement("div");
      rows.className = "dcla-rows";
      var boxes = [];
      var pickers = [];

      var addRow = function (entry) {
        if (boxes.length >= 20) return;
        var box = document.createElement("div");
        box.className = "dcla-edit-row";
        var scope = editorPicker("dcla-scope", zh.scopeLabel, SCOPE_ORDER, zh.scopeWords,
          entry === null ? (presetScope === undefined || presetScope === null ? "all" : presetScope) : entry.scope);
        var purpose = editorPicker("dcla-purpose", zh.purposeLabel, PURPOSE_ORDER, zh.kindWords,
          entry === null ? "app" : entry.kind);
        var name = editorInput("dcla-name", zh.namePlaceholder, entry === null ? "" : entry.label);
        var value = editorInput("dcla-value", zh.valuePlaceholder, entry === null ? "" : entry.value);
        var syncValue = function () {
          var word = zh.valueHints[purpose.value];
          value.placeholder = word === undefined || word === "" ? zh.valuePlaceholder : word;
          value.style.display = purpose.value === "share" ? "none" : "";
        };
        purpose.onChange = syncValue;
        syncValue();
        pickers.push(scope);
        pickers.push(purpose);
        var drop = document.createElement("button");
        drop.type = "button";
        drop.className = "dcla-drop";
        drop.textContent = zh.removeRow;
        drop.addEventListener("click", function () {
          var at = boxes.indexOf(box);
          if (at >= 0) boxes.splice(at, 1);
          if (box.parentNode !== null) box.parentNode.removeChild(box);
        });
        box.appendChild(scope);
        box.appendChild(purpose);
        box.appendChild(drop);
        box.appendChild(name);
        box.appendChild(value);
        rows.appendChild(box);
        boxes.push(box);
        return box;
      };

      customActions.forEach(function (entry) { addRow(entry); });
      /* 一个入口都没有时给一行空白的，别让人对着空面板找入口。 */
      if (boxes.length === 0 || (presetScope !== undefined && presetScope !== null)) addRow(null);

      var footer = document.createElement("div");
      footer.className = "dcla-editor-row";
      var add = document.createElement("button");
      add.type = "button";
      add.setAttribute("data-add", "true");
      add.textContent = zh.addRow;
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = zh.cancel;
      var save = document.createElement("button");
      save.type = "button";
      save.setAttribute("data-primary", "true");
      save.textContent = zh.save;
      footer.appendChild(add);
      footer.appendChild(cancel);
      footer.appendChild(save);

      panel.appendChild(rows);
      panel.appendChild(footer);
      layer.appendChild(panel);
      document.body.appendChild(layer);

      var place = function () {
        var box = panel.getBoundingClientRect();
        panel.style.left = Math.round(Math.max(12, (window.innerWidth - box.width) / 2)) + "px";
        panel.style.top = Math.round(Math.max(12, (window.innerHeight - box.height) / 3)) + "px";
      };
      place();

      var close = function () {
        pickers.forEach(function (picker) { picker.dismiss(); });
        if (layer.parentNode !== null) layer.parentNode.removeChild(layer);
        document.removeEventListener("keydown", onKey, true);
      };
      var onKey = function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      };

      add.addEventListener("click", function () {
        var box = addRow(null);
        if (box !== undefined) {
          var field = box.querySelector(".dcla-name");
          if (field !== null) field.focus();
          place();
        }
      });
      cancel.addEventListener("click", close);
      save.addEventListener("click", function () {
        var entries = [];
        boxes.forEach(function (box) {
          var scope = box.querySelector(".dcla-scope");
          var purpose = box.querySelector(".dcla-purpose");
          var name = box.querySelector(".dcla-name");
          var value = box.querySelector(".dcla-value");
          if (scope === null || purpose === null || name === null || value === null) return;
          var label = String(name.value === undefined || name.value === null ? "" : name.value).trim();
          var payload = String(value.value === undefined || value.value === null ? "" : value.value).trim();
          if (label === "") return;
          if (purpose.value !== "share" && payload === "") return;
          entries.push({ label: label, kind: purpose.value, value: payload, scope: scope.value });
        });
        postJson("actions-save", { actions: entries }).then(function (data) {
          customActions = Array.isArray(data.actions) ? data.actions : [];
          customLoaded = true;
          close();
          toast(zh.saved);
        }, function (error) {
          report("actions-save-failed " + String((error && error.message) || error));
          toast(zh.saveFailed);
        });
      });

      document.addEventListener("keydown", onKey, true);
      var first = rows.querySelector(".dcla-name");
      if (first !== null) first.focus();
    }

    function openMenu(path, x, y, options) {
      closeMenu(false);
      ensureStyle();
      var settings = options === null || options === undefined ? {} : options;

      var image = settings.image === undefined || settings.image === null ? null : String(settings.image);
      var url = settings.url === undefined || settings.url === null ? null : String(settings.url);
      var hasPath = path !== null && path !== undefined;
      var cardName = settings.name === undefined || settings.name === null ? null : String(settings.name);
      var kind = kindOfTarget({ path: hasPath ? path : null, name: cardName });
      var items = [];
      if (image !== null) {
        items.push({ id: "copyImage", label: strings().copyImage, icon: "image", run: function () {
          copyImage(image);
        } });
      }

      var pathItems = [
        { id: "quote", label: strings().quote, icon: "quote", run: function () {
          var sessionId = settings.sessionId;
          var directory = settings.directory;
          if (directory === undefined || directory === null) directory = guessDirectory(path);
          quoteIntoComposer(path, directory, sessionId);
        } },
        { id: "reveal", label: strings().reveal, icon: "reveal", run: function () {
          reveal(path);
        } },
        { id: "copy", label: strings().copy, icon: "copy", run: function () {
          navigator.clipboard.writeText(path).then(function () {
            toast(strings().copiedPath);
          }, function () {
            toast(strings().clipboardFailed);
          });
        } },
        { id: "share", label: strings().share, icon: "share", run: function () {
          runShare(path);
        } }
      ];

      if (settings.inField === true) {
        pathItems = pathItems.filter(function (item) {
          return item.id !== "quote";
        });
      }
      if (hasPath) items = items.concat(pathItems);
      else if (cardName !== null) {
        items.push({ id: "copyName", label: strings().copyName, icon: "copy", run: function () {
          navigator.clipboard.writeText(cardName).then(function () {
            toast(strings().copiedName);
          }, function () {
            toast(strings().clipboardFailed);
          });
        } });
      }
      if (url !== null) {
        items.push({ id: "copyLink", label: strings().copyLink, icon: "copy", run: function () {
          navigator.clipboard.writeText(url).then(function () {
            toast(strings().copiedLink);
          }, function () {
            toast(strings().clipboardFailed);
          });
        } });
      }
      if (hasPath || url !== null) {
        try {
          items = items.concat(customMenuItems({
            path: hasPath ? path : "",
            url: url === null ? "" : url,
            name: cardName === null ? "" : cardName
          }));
        } catch (ignored) {
          /* 自定义条目读不出来时，基础菜单照常给 */
        }
      }
      if (hasPath || url !== null || cardName !== null) {
        items.push({ id: "customize", label: strings().customize, icon: "custom", run: function () {
          openActionsEditor(null);
        } });
        if (kind !== null) {
          items.push({ id: "customizeKind", label: strings().addKindEntry.replace("{kind}", strings().scopeWords[kind]), icon: "custom", run: function () {
            openActionsEditor(kind);
          } });
        }
      }
      if (items.length === 0) return;

      var layer = document.createElement("div");
      layer.className = "dcla-layer";
      var built = buildMenu(hasPath ? path : "", items);
      layer.appendChild(built.panel);
      document.body.appendChild(layer);

      var state = {};
      state.layer = layer;
      state.panel = built.panel;
      state.buttons = built.buttons;
      state.items = items;
      state.index = 0;
      state.path = path;
      state.x = x;
      state.y = y;
      state.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      open = state;
      placeMenu(built.panel, x, y);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("contextmenu", onContextDuringMenu, true);
      window.addEventListener("resize", onViewportChange, true);
      window.addEventListener("scroll", onViewportChange, true);
    }

    /* ── small toast for the actions that do not change the screen ──────── */

    var toastTimer = null;
    var toastNode = null;

    function toast(text) {
      ensureStyle();
      if (toastNode !== null && toastNode.parentNode !== null) toastNode.parentNode.removeChild(toastNode);
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastNode = document.createElement("div");
      toastNode.className = "dcla-toast";
      toastNode.setAttribute("role", "status");
      toastNode.textContent = text;
      document.body.appendChild(toastNode);
      toastTimer = setTimeout(function () {
        if (toastNode !== null && toastNode.parentNode !== null) toastNode.parentNode.removeChild(toastNode);
        toastNode = null;
        toastTimer = null;
      }, 1400);
    }

    /** 当前会话提供的应用服务；没有会话时返回空。 */
    function sessionRemote() {
      var context = sessionContext();
      var remote = context === null ? undefined : context.remote;
      if (remote !== undefined && remote !== null) return remote;
      var root = rootContext === null ? undefined : rootContext.remote;
      return root === undefined || root === null ? null : root;
    }

    /** 第一条可用会话的上下文，应用的会话服务挂在它上面。 */
    function sessionContext() {
      if (rootContext === null || typeof rootContext.sessions !== "object" || rootContext.sessions === null) return null;
      var candidates = draftCandidates();
      for (var i = 0; i < candidates.length; i += 1) {
        try {
          var binding = rootContext.sessions.binding(candidates[i].sessionId);
          var context = binding === null || binding === undefined ? null : binding.ctx;
          if (context !== null && context !== undefined) return context;
        } catch (error) {
          /* try the next session */
        }
      }
      return null;
    }

    /** 在系统文件管理器里选中路径；路径不存在时直接告知。 */
    /** 去掉末尾分隔符：菜单标题常带着它，文件路径带上就打不开了。 */
    function withoutTrailingSeparator(path) {
      var trimmed = path.replace(/[\\/]+$/u, "");
      if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed)) return path;
      return trimmed;
    }

    /** 点击路径上的每一步都留一行日志，静默失败就不再只能靠猜。 */
    var reported = {};
    function report(note) {
      try {
        var text = String(note);
        if (reported[text] === true) return;
        reported[text] = true;
        fetch("/chat-link-actions?action=trace&note=" + encodeURIComponent(text), { method: "POST", keepalive: true }).catch(function () {});
      } catch (ignored) {
        /* diagnostics must never throw */
      }
    }

    /**
     * One click performs at most one desktop action. A timeout means "result
     * unknown", not "did not run": the window may still appear, so no second
     * channel is fired and a late success is never turned into a failure toast.
     */
    function reveal(path) {
      var attempt = { done: false };
      var target = withoutTrailingSeparator(path);
      report("reveal-start " + target);
      try {
        revealNative(target, attempt);
      } catch (error) {
        finishAttempt(attempt, strings().managerFailed);
        report("reveal-threw " + String((error && error.message) || error));
      }
    }

    function finishAttempt(attempt, message) {
      if (attempt.done) return false;
      attempt.done = true;
      if (message !== undefined) toast(message);
      return true;
    }

    /** 首选：应用的原生打开能力，macOS 访达、Windows 资源管理器同一套。 */
    function revealNative(path, attempt) {
      if (attempt.done) return;
      var remote = sessionRemote();
      var session = null;
      try {
        session = remote === null || remote === undefined ? null : remote.session;
      } catch (error) {
        session = null;
      }
      if (session === null || session === undefined || typeof session.openWorkspacePath !== "function") {
        revealViaRoute(path, attempt);
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled || attempt.done) return;
        settled = true;
        report("reveal-timeout " + path);
        /* 没有回执不等于没有执行：这里不再换通道开第二次。 */
        finishAttempt(attempt, strings().revealPending);
      }, 2500);
      var stop = function (result, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        afterReveal(path, result, error, attempt);
      };
      try {
        var pending = session.openWorkspacePath({ path: path, action: "reveal" });
        if (pending === null || pending === undefined || typeof pending.then !== "function") {
          afterReveal(path, pending, null, attempt);
          return;
        }
        pending.then(function (result) {
          stop(result, null);
        }, function (error) {
          stop(null, error);
        });
      } catch (error) {
        afterReveal(path, null, error, attempt);
      }
    }

    function openedBy(result) {
      if (result === true) return true;
      if (result === null || result === undefined || typeof result !== "object") return false;
      return result.ok === true || result.opened === true || result.revealed === true;
    }

    /** 明确的失败：抛了 error，或回执把 ok/opened/revealed 说成 false。 */
    function explicitFailure(result, error) {
      if (error !== null && error !== undefined) return describeReveal(null, error) || "error";
      if (result === false) return "false";
      if (result === null || result === undefined || typeof result !== "object") return null;
      if (result.ok === false || result.opened === false || result.revealed === false) {
        return describeReveal(result, null) || "failed";
      }
      return null;
    }

    /**
     * 四种回执，各自的下一步是固定的：
     * opened 结束；unsupported 换后备通道；failed 报错；pending 只提示、
     * 不再开第二条通道（超时说明结果未知，不等于没执行）。
     */
    function revealVerdict(result, error) {
      if (openedBy(result)) return "opened";
      if (explicitFailure(result, error) !== null) {
        return isUnsupported(result, error) ? "unsupported" : "failed";
      }
      /* 没有 ok/opened 字段但有 code/message 的回执也算有信息：能说不支持
         就换通道，说不清就当结果未知。 */
      if (isUnsupported(result, error)) return "unsupported";
      return "pending";
    }

    function afterReveal(path, result, error, attempt) {
      if (attempt.done) return;
      var verdict = revealVerdict(result, error);
      if (verdict === "opened") {
        finishAttempt(attempt);
        return;
      }
      if (verdict === "unsupported") {
        revealViaRoute(path, attempt);
        return;
      }
      if (verdict === "pending") {
        report("reveal-pending " + path);
        finishAttempt(attempt, strings().revealPending);
        return;
      }
      report("reveal-failed " + describeReveal(result, error));
      finishAttempt(attempt, strings().managerFailed);
    }

    function isUnsupported(result, error) {
      var text = describeReveal(result, error).toLowerCase();
      if (text === "") return false;
      return /not[- ]?supported|unsupported|not[- ]?implemented|no such (?:method|function)|unknown (?:method|action)/.test(text);
    }

    function describeReveal(result, error) {
      var source = error !== null && error !== undefined ? error : result;
      if (source === null || source === undefined || typeof source !== "object") return "";
      var parts = [source.code, source.message];
      if (source.error !== null && typeof source.error === "object") {
        parts.push(source.error.code, source.error.message);
      }
      return parts.filter(function (part) {
        return part !== undefined && part !== null && part !== "";
      }).join(" ");
    }

    /** 后备：插件自己的 HTTP 路由（页面同源时可用）。 */
    function revealViaRoute(path, attempt) {
      if (attempt.done) return;
      report("route " + path);
      var settle = function (message) {
        if (message === undefined) {
          finishAttempt(attempt);
          return;
        }
        report("route-failed " + message);
        finishAttempt(attempt, message);
      };
      try {
        fetch("/chat-link-actions?action=reveal&path=" + encodeURIComponent(path), { method: "POST" }).then(function (response) {
          report("route-status " + response.status + " " + path);
          if (response.ok) {
            settle();
            return;
          }
          settle(response.status === 404 ? strings().missing : strings().managerFailed);
        }, function () {
          settle(strings().managerFailed);
        });
      } catch (error) {
        settle(strings().managerFailed);
      }
    }

    /** 插件自己的故障只记一条日志，绝不让页面上的右键整体失效。 */
    function noteFailure(error) {
      try {
        toast(strings().menuFailed);
      } catch (ignored) {
        /* a failure toast must never throw either */
      }
      try {
        var context = rootContext;
        if (context !== null && context !== undefined && typeof context.logger?.warn === "function") {
          context.logger.warn("chat-link-actions: menu failed: " + String(error && error.message ? error.message : error));
        }
      } catch (ignored) {
        /* logging must never throw */
      }
    }

    /** 能打字的区域：输入框、文本域、可编辑块。用于区分「在输入框里」与页面正文。 */
    function editableField(node) {
      for (var el = node; el !== null && el !== undefined; el = el.parentElement) {
        if (el.nodeType !== 1) continue;
        var tag = el.tagName;
        if (tag === "TEXTAREA" || tag === "SELECT") return true;
        if (tag === "INPUT") {
          var kind = String(el.getAttribute("type") || "text").toLowerCase();
          if (kind === "checkbox" || kind === "radio" || kind === "button" || kind === "submit" || kind === "file" || kind === "range") continue;
          return true;
        }
        if (el.isContentEditable === true) return true;
        var editable = el.getAttribute("contenteditable");
        if (editable === "true" || editable === "") return true;
      }
      return false;
    }

    /** Prose needs a real path shape: /help and skill chips must stay native. */
    function looksLikePath(value) {
      if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
      var rest = value.replace(/^(?:[A-Za-z]:)?[\\/]+/u, "");
      if (rest === "") return false;
      if (/[\\/]/u.test(rest)) return true;
      return /\.[A-Za-z0-9]{1,8}$/u.test(rest);
    }

    /** 右键来自哪个会话：先看组件属性，再退回最近渲染的输入框。 */
    function sessionOfNode(node) {
      for (var owner = node; owner !== null && owner !== undefined && owner !== document.body; owner = owner.parentElement) {
        if (owner.nodeType !== 1) continue;
        var fiber = fiberOf(owner);
        for (var step = 0, cursor = fiber; step < 12 && cursor !== null && cursor !== undefined; step += 1, cursor = cursor.return) {
          var props = cursor.memoizedProps;
          if (props === null || typeof props !== "object") continue;
          if (typeof props.sessionId === "string" && props.sessionId !== "") return props.sessionId;
          var boxed = props.session;
          if (boxed !== null && typeof boxed === "object" && typeof boxed.id === "string" && boxed.id !== "") return boxed.id;
        }
      }
      return activeSession;
    }

    /** 兜底：只解析路径和链接，附加信息一律跳过。 */
    function optionsForBareMenu(event) {
      var target = event.target;
      var image = null;
      var path = null;
      var url = null;
      try { image = imageTarget(target); } catch (ignored) { image = null; }
      try { url = image === null ? linkTarget(target) : null; } catch (ignored) { url = null; }
      try {
        path = image === null ? pathFromNode(target, { x: event.clientX, y: event.clientY, allowProse: true }) : imageFilePath(image);
      } catch (ignored) { path = null; }
      if (path !== null && !looksLikePath(path)) path = null;
      var options = { inField: false, image: null, url: url };
      return { path: path, url: url, options: options };
    }

    function onContextMenu(event) {
      if (!(event.target instanceof Element)) return;
      var target = event.target;
      var probeTag = target.tagName + "." + String(target.className || "").slice(0, 60);
      try {
        var inField = editableField(target);
        var image = imageTarget(target);
        var imageUrl = image === null ? null : imageSource(image);
        var url = imageUrl === null ? linkTarget(target) : outerLinkHref(target);
        proseCandidate = false;
        var path = null;
        var cardName = null;
        if (image === null) {
          path = pathFromNode(target, { x: event.clientX, y: event.clientY, allowProse: !inField });
        } else {
          path = imageFilePath(image);
          if (path === null) path = pathFromNode(target, { x: event.clientX, y: event.clientY, allowProse: false, strict: true });
        }
        if (path === null && image === null) {
          var card = null;
          try { card = attachmentCard(target); } catch (ignored) { card = null; }
          if (card !== null) {
            var cardLabel = null;
            try { cardLabel = cardFileName(card); } catch (ignored) { cardLabel = null; }
            if (cardLabel !== null) {
              if (looksAbsolute(cardLabel)) {
                path = cardLabel;
              } else {
                var matched = null;
                try { matched = pathForCardName(card, baseNameOf(cardLabel)); } catch (ignored) { matched = null; }
                if (matched !== null) path = matched;
                else cardName = cardLabel;
              }
            }
          }
        }
        report("ctx " + probeTag + " path=" + (path === null ? "null" : String(path).slice(0, 140)) + " img=" + (imageUrl === null ? "null" : String(imageUrl).slice(0, 100)) + " url=" + (url === null ? "null" : String(url).slice(0, 100)));
        if (path === null && imageUrl === null && url === null && cardName === null) return;
        if (path !== null && proseCandidate && !looksLikePath(path)) return;
        var options = {};
        options.inField = inField;
        try { options.directory = directoryHint(target); } catch (ignored) { options.directory = undefined; }
        try { options.sessionId = sessionOfNode(target); } catch (ignored) { options.sessionId = activeSession; }
        options.image = imageUrl;
        options.url = url;
        options.name = cardName;
        openMenu(path, event.clientX, event.clientY, options);
        event.preventDefault();
        event.stopPropagation();
      } catch (error) {
        var why = error && error.message ? error.message : String(error);
        report("ctx-threw " + why + " | " + String(error && error.stack ? error.stack : "").replace(/\s+/gu, " ").slice(0, 400));
        closeMenu(false);
        /* 附加能力坏了也要给基础菜单：引用、定位、复制永远在。 */
        try {
          var bare = optionsForBareMenu(event);
          if (bare.path !== null || bare.url !== null) {
            openMenu(bare.path, event.clientX, event.clientY, bare.options);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        } catch (ignored) {
          /* fall through to the failure toast */
        }
        noteFailure(error);
      }
    }

    /* ── plugin entry ───────────────────────────────────────────────────── */

    var inject = ["slots", "sessions", "remote", "remote.session"];

    function apply(ctx) {
      report("ready 0.6.13");
      rootContext = ctx;
      refreshCustomActions();
      ctx.effect(function () {
        var timer = setInterval(refreshCustomActions, 4000);
        var onFocus = function () {
          refreshCustomActions();
        };
        window.addEventListener("focus", onFocus);
        return function () {
          clearInterval(timer);
          window.removeEventListener("focus", onFocus);
        };
      });
      ctx.effect(function () {
        document.addEventListener("contextmenu", onContextMenu, true);
        return function () {
          document.removeEventListener("contextmenu", onContextMenu, true);
          closeMenu(false);
        };
      });
      ctx.effect(function () {
        return ctx.slots.inject("conversation.input.overlay", function () {
          return ctx.slots.register({
            name: "conversation.input.overlay",
            id: "chat-link-actions",
            order: 900
          }, DraftCapture);
        });
      });
    }

    /* 纯路径层只是给回归测试用：它不碰页面，也不进 UI。 */
    var testSeams = {};
    testSeams.normalizeCandidate = function (value) { return normalizeCandidate(value, true); };
    testSeams.normalizeStrict = function (value) { return normalizeCandidate(value, false); };
    testSeams.decodeFileUri = decodeFileUri;
    testSeams.decodePathFromHref = decodePathFromHref;
    testSeams.joinPathWords = joinPathWords;
    testSeams.stripLineSuffix = stripLineSuffix;
    testSeams.looksLikePath = looksLikePath;
    testSeams.withoutTrailingSeparator = withoutTrailingSeparator;
    testSeams.editableField = editableField;
    testSeams.contextMenu = onContextMenu;
    testSeams.imageTarget = imageTarget;
    testSeams.pathFromNode = pathFromNode;
    testSeams.datasetPath = datasetPath;
    testSeams.srcsetPath = srcsetPath;
    testSeams.imageFilePath = imageFilePath;
    testSeams.pathFromProps = pathFromProps;
    testSeams.directoryHint = directoryHint;
    testSeams.guessDirectory = guessDirectory;
    testSeams.referenceText = referenceText;
    testSeams.linkTarget = linkTarget;
    testSeams.outerLinkHref = outerLinkHref;
    testSeams.attachmentCard = attachmentCard;
    testSeams.cardFileName = cardFileName;
    testSeams.pathForCardName = pathForCardName;
    testSeams.baseNameOf = baseNameOf;
    testSeams.kindOfName = kindOfName;
    testSeams.kindOfTarget = kindOfTarget;
    testSeams.menuEntriesFor = menuEntriesFor;
    testSeams.revealVerdict = revealVerdict;
    testSeams.insertChip = insertChip;
    testSeams.PURPOSE_ORDER = function () { return PURPOSE_ORDER.slice(); };
    testSeams.pickerCurrent = pickerCurrent;
    testSeams.customFailureText = customFailureText;
    testSeams.toPngBlob = toPngBlob;
    testSeams.KIND_LIST = function () { return PURPOSE_ORDER.slice(); };
    testSeams.setRootContext = function (value) { rootContext = value === undefined ? null : value; };
    testSeams.expandHomePath = expandHomePath;
    testSeams.setHome = function (value) { homePath = value === undefined ? null : value; };
    module.exports = {};
    module.exports.inject = inject;
    module.exports.apply = apply;
    module.exports.__paths = testSeams;
    return module.exports;
  }
});
