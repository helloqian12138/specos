export type ParsedSpecProject = {
  app?: SpecAppInfo;
  settings: SpecSettingGroup[];
  blocks: SpecBlock[];
  extensionBlocks: SpecBlock[];
  entities: SpecEntity[];
  actions: SpecAction[];
  pages: SpecPage[];
  components: SpecComponent[];
  states: SpecState[];
};

export type SpecAppInfo = {
  label: string;
  description: string;
};

export type SpecSettingGroup = {
  name: string;
  entries: SpecSettingEntry[];
  rawBody: string;
};

export type SpecSettingEntry = {
  key: string;
  value: string;
};

export type SpecBlock = {
  kind: string;
  name?: string;
  qualifier?: string;
  header: string;
  body: string;
  sections: SpecBlockSection[];
};

export type SpecBlockSection = {
  name: string;
  value?: string;
  body: string;
};

export type SpecEntity = {
  name: string;
  fields: string[];
};

export type SpecAction = {
  name: string;
  apiPath?: string;
  inputFields: string[];
  returnFields: string[];
};

export type SpecPage = {
  name: string;
  route: string;
  tables: SpecTable[];
  buttons: string[];
  layouts: string[];
  texts: string[];
  controls: SpecControl[];
  buttonFlows: SpecButtonFlow[];
};

export type SpecTable = {
  stateName: string;
  columns: string[];
};

export type SpecComponent = {
  name: string;
  formFields: string[];
  buttons: string[];
  modalTitles: string[];
  formControls: SpecFormField[];
  submitFlow?: SpecSubmitFlow;
};

export type SpecState = {
  name: string;
  source?: string;
};

export type SpecControl = {
  kind: string;
  name?: string;
  label?: string;
};

export type SpecFormField = {
  name: string;
  control: string;
};

export type SpecButtonFlow = {
  label: string;
  dispatchAction?: string;
  refreshState?: string;
  openModal?: string;
};

export type SpecSubmitFlow = {
  dispatchAction?: string;
  refreshState?: string;
  closeModal: boolean;
};

export function parseSpecProject(specContext: string): ParsedSpecProject {
  const blocks = parseTopLevelBlocks(specContext);
  return {
    app: parseAppInfo(specContext),
    settings: parseSettingGroups(specContext),
    blocks,
    extensionBlocks: blocks.filter(
      block => !["entity", "action", "page", "component", "state"].includes(block.kind.toLowerCase())
    ),
    entities: parseEntities(specContext),
    actions: parseActions(specContext),
    pages: parsePages(specContext),
    components: parseComponents(specContext),
    states: parseStates(specContext)
  };
}

function parseEntities(input: string): SpecEntity[] {
  return collectBlocks(input, /^Entity\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm).map(block => ({
    name: block.name,
    fields: collectEntityFields(block.body)
  }));
}

function parseActions(input: string): SpecAction[] {
  return collectBlocks(input, /^Action\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm).map(block => {
    const apiMatch = block.body.match(/^\s{2}API\s+(?:GET|POST|PUT|PATCH|DELETE)\s+([^\s]+)\s*$/m);
    return {
      name: block.name,
      apiPath: apiMatch?.[1],
      inputFields: parseNamedSectionFields(block.body, "Input"),
      returnFields: parseNamedSectionFields(block.body, "Return")
    };
  });
}

function parsePages(input: string): SpecPage[] {
  return collectBlocks(input, /^Page\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((\/[^)\s]+)\)\s*:/gm).map(block => ({
    name: block.name,
    route: block.extra ?? "/",
    tables: parseTables(block.body),
    buttons: collectQuotedButtonLabels(block.body),
    layouts: collectLayouts(block.body),
    texts: collectTextLiterals(block.body),
    controls: collectInlineControls(block.body),
    buttonFlows: parseButtonFlows(block.body)
  }));
}

function parseComponents(input: string): SpecComponent[] {
  return collectBlocks(input, /^Component\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gm).map(block => ({
    name: block.name,
    formFields: parseFormFields(block.body),
    buttons: collectQuotedButtonLabels(block.body),
    modalTitles: collectModalTitles(block.body),
    formControls: parseFormControls(block.body),
    submitFlow: parseSubmitFlow(block.body)
  }));
}

function parseStates(input: string): SpecState[] {
  const stateBlocks = extractNamedSectionBlocks(input, "State");
  const results: SpecState[] = [];

  for (const stateBlock of stateBlocks) {
    const lines = stateBlock
      .split("\n")
      .map(line => line.replace(/\r/g, ""))
      .filter(line => line.trim().length > 0);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const stateMatch = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
      if (!stateMatch) {
        continue;
      }

      const name = stateMatch[1];
      let source: string | undefined;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const nested = lines[cursor];
        if (/^\s{2}\S/.test(nested)) {
          break;
        }

        const sourceMatch = nested.match(/^\s{4}source:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (sourceMatch) {
          source = sourceMatch[1];
          break;
        }
      }

      results.push({ name, source });
    }
  }

  return results;
}

function parseTables(body: string): SpecTable[] {
  const tables: SpecTable[] = [];
  const tableRegex = /^\s*table\(([A-Za-z_][A-Za-z0-9_]*)\)\s*:\s*$/gm;

  for (const match of body.matchAll(tableRegex)) {
    const stateName = match[1];
    const after = body.slice(match.index ?? 0).split("\n").slice(1);
    const columns: string[] = [];
    let inColumns = false;

    for (const line of after) {
      if (/^\s{8}columns:\s*$/.test(line)) {
        inColumns = true;
        continue;
      }

      if (!inColumns) {
        if (/^\s{6}\S/.test(line)) {
          break;
        }
        continue;
      }

      const columnMatch = line.match(/^\s{10}([A-Za-z_][A-Za-z0-9_]*)\s*(?::)?/);
      if (columnMatch) {
        columns.push(columnMatch[1]);
        continue;
      }

      if (/^\s{8}\S/.test(line) || /^\s{6}\S/.test(line)) {
        break;
      }
    }

    tables.push({ stateName, columns });
  }

  return tables;
}

function parseFormFields(body: string): string[] {
  return parseFormControls(body).map(field => field.name);
}

function parseFormControls(body: string): SpecFormField[] {
  const formBlock = extractNamedSectionBlocks(body, "form")[0];
  if (!formBlock) {
    return [];
  }

  const fields: SpecFormField[] = [];
  for (const line of formBlock.split("\n")) {
    const match = line.match(/^\s{6}field\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^,)]+)/);
    if (match) {
      fields.push({
        name: match[1],
        control: match[2].trim()
      });
    }
  }

  return fields;
}

function parseNamedSectionFields(body: string, sectionName: string): string[] {
  const blocks = extractNamedSectionBlocks(body, sectionName);
  const names = new Set<string>();

  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      for (const token of trimmed.split(",")) {
        const normalized = normalizeFieldToken(token);
        if (normalized) {
          names.add(normalized);
        }
      }
    }
  }

  return Array.from(names);
}

function collectIndentedNames(body: string, indent: number): string[] {
  const pattern = new RegExp(`^\\s{${indent}}([A-Za-z_][A-Za-z0-9_]*)\\s*:`, "gm");
  return Array.from(body.matchAll(pattern)).map(match => match[1]);
}

function collectQuotedButtonLabels(body: string): string[] {
  return Array.from(body.matchAll(/button\("([^"]+)"(?:,\s*[^)]*)?\)/g)).map(match => match[1]);
}

function collectTextLiterals(body: string): string[] {
  return Array.from(body.matchAll(/text\("([^"]+)"(?:,\s*[^)]*)?\)/g)).map(match => match[1]);
}

function collectLayouts(body: string): string[] {
  return Array.from(body.matchAll(/layout:\s*([^\n]+)/g)).map(match => match[1].trim());
}

function collectModalTitles(body: string): string[] {
  return Array.from(body.matchAll(/modal\("([^"]+)"\)/g)).map(match => match[1]);
}

function collectInlineControls(body: string): SpecControl[] {
  const controls: SpecControl[] = [];

  for (const match of body.matchAll(/\b(input|table)\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
    controls.push({
      kind: match[1],
      name: match[2]
    });
  }

  for (const match of body.matchAll(/\bbutton\("([^"]+)"(?:,\s*([^)]+))?\)/g)) {
    controls.push({
      kind: "button",
      label: match[1],
      name: match[2]?.trim()
    });
  }

  return controls;
}

function parseButtonFlows(body: string): SpecButtonFlow[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const flows: SpecButtonFlow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*button\("([^"]+)"(?:,\s*[^)]*)?\):\s*$/);
    if (!match) {
      continue;
    }

    const label = match[1];
    let dispatchAction: string | undefined;
    let refreshState: string | undefined;
    let openModal: string | undefined;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nested = lines[cursor];
      if (/^\s{6}(?:Left|Right|Section)\b/.test(nested) || /^\s{4}\S/.test(nested) || /^---\s*$/.test(nested)) {
        break;
      }

      const dispatchMatch = nested.match(/\bdispatch\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (dispatchMatch) {
        dispatchAction = dispatchMatch[1];
      }

      const refreshMatch = nested.match(/\brefresh\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (refreshMatch) {
        refreshState = refreshMatch[1];
      }

      const modalMatch = nested.match(/\bopenModal\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (modalMatch) {
        openModal = modalMatch[1];
      }
    }

    flows.push({
      label,
      dispatchAction,
      refreshState,
      openModal
    });
  }

  return flows;
}

function parseSubmitFlow(body: string): SpecSubmitFlow | undefined {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let inSubmit = false;
  let dispatchAction: string | undefined;
  let refreshState: string | undefined;
  let closeModal = false;

  for (const line of lines) {
    if (/^\s{4}onSubmit:\s*$/.test(line)) {
      inSubmit = true;
      continue;
    }

    if (!inSubmit) {
      continue;
    }

    if (/^\s{2}\S/.test(line) || /^---\s*$/.test(line)) {
      break;
    }

    const dispatchMatch = line.match(/\bdispatch\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (dispatchMatch) {
      dispatchAction = dispatchMatch[1];
    }

    const refreshMatch = line.match(/\brefresh\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (refreshMatch) {
      refreshState = refreshMatch[1];
    }

    if (/\bcloseModal\b/.test(line)) {
      closeModal = true;
    }
  }

  if (!dispatchAction && !refreshState && !closeModal) {
    return undefined;
  }

  return {
    dispatchAction,
    refreshState,
    closeModal
  };
}

function normalizeFieldToken(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1];
}

function collectEntityFields(body: string): string[] {
  const fields: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!match) {
      continue;
    }

    const fieldName = match[1];
    if (isStructuralSectionName(fieldName)) {
      continue;
    }

    fields.push(fieldName);
  }

  return fields;
}

function parseAppInfo(input: string): SpecAppInfo | undefined {
  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^App\s*:\s*(.+)$/);
    if (match) {
      return {
        label: "App",
        description: match[1].trim()
      };
    }
  }

  return undefined;
}

function parseSettingGroups(input: string): SpecSettingGroup[] {
  const groups: SpecSettingGroup[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/);
    if (!match) {
      continue;
    }

    const name = match[1];
    if (isTypedBlockName(name)) {
      continue;
    }

    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nested = lines[cursor];
      if (/^---\s*$/.test(nested) || /^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*$/.test(nested)) {
        break;
      }
      collected.push(nested);
    }

    const rawBody = collected.join("\n");
    const entries = collected
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const entryMatch = item.match(/^([^=:#]+?)\s*(?:=|:)\s*(.+)$/);
        return entryMatch
          ? { key: entryMatch[1].trim(), value: entryMatch[2].trim() }
          : undefined;
      })
      .filter((entry): entry is SpecSettingEntry => entry !== undefined);

    groups.push({ name, entries, rawBody });
  }

  return groups;
}

function parseTopLevelBlocks(input: string): SpecBlock[] {
  const chunks = input
    .replace(/\r\n/g, "\n")
    .split(/\n---+\n/g)
    .map(chunk => chunk.trim())
    .filter(Boolean);

  const blocks: SpecBlock[] = [];

  for (const chunk of chunks) {
    const [headerLine, ...rest] = chunk.split("\n");
    const header = headerLine.trim();
    const body = rest.join("\n");
    const blockMatch = header.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)(?:\s+([A-Za-z_][A-Za-z0-9_:-]*))?(?:\s*\(([^)]*)\))?\s*:\s*(.*)?$/
    );
    if (!blockMatch) {
      continue;
    }

    const kind = blockMatch[1];
    const name = blockMatch[2];
    const qualifier = blockMatch[3] || blockMatch[4] || undefined;
    blocks.push({
      kind,
      name,
      qualifier,
      header,
      body,
      sections: parseBlockSections(body)
    });
  }

  return blocks;
}

function parseBlockSections(body: string): SpecBlockSection[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections: SpecBlockSection[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const name = match[1];
    const inlineValue = match[2].trim() || undefined;
    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nested = lines[cursor];
      if (/^\s{2}[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(nested)) {
        break;
      }
      collected.push(nested);
    }

    sections.push({
      name,
      value: inlineValue,
      body: collected.join("\n")
    });
  }

  return sections;
}

function isTypedBlockName(name: string): boolean {
  return ["Entity", "Action", "Page", "Component", "State"].includes(name);
}

function isStructuralSectionName(name: string): boolean {
  return [
    "Input",
    "Do",
    "Return",
    "Header",
    "Content",
    "onError",
    "Theme",
    "Environment",
    "Goal",
    "State"
  ].includes(name);
}

function extractNamedSectionBlocks(body: string, sectionName: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = line.match(new RegExp(`^\\s{2}${escapeRegExp(sectionName)}:\\s*$`, "i"));
    if (!sectionMatch) {
      continue;
    }

    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nested = lines[cursor];
      if (/^\s{2}\S/.test(nested) || /^---\s*$/.test(nested)) {
        break;
      }
      collected.push(nested);
    }

    blocks.push(collected.join("\n"));
  }

  return blocks;
}

function collectBlocks(
  input: string,
  pattern: RegExp
): Array<{ name: string; body: string; extra?: string }> {
  const matches = Array.from(input.matchAll(pattern));
  const results: Array<{ name: string; body: string; extra?: string }> = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.index === undefined) {
      continue;
    }

    const start = match.index + match[0].length;
    const nextMatchIndex = index + 1 < matches.length && matches[index + 1].index !== undefined
      ? matches[index + 1].index
      : input.length;
    const separatorIndex = input.indexOf("\n---", start);
    const end =
      separatorIndex !== -1 && separatorIndex < nextMatchIndex
        ? separatorIndex
        : nextMatchIndex;
    results.push({
      name: match[1],
      extra: match[2],
      body: input.slice(start, end)
    });
  }

  return results;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
