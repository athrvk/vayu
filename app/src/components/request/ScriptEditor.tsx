/**
 * ScriptEditor - Monaco-based code editor for pre-request and test scripts
 * Fetches completions from backend script engine for accurate autocomplete
 */

import { useRef, useEffect } from "react";
import Editor, { OnMount, BeforeMount } from "@monaco-editor/react";
import type { editor, IPosition } from "monaco-editor";
import { useScriptCompletionsStore } from "@/stores/script-completions-store";

interface ScriptEditorProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    height?: string;
}

// Store disposable to clean up on unmount
let completionDisposable: { dispose: () => void } | null = null;

export default function ScriptEditor({
    value,
    onChange,
    height = "384px",
}: ScriptEditorProps) {
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const { fetchCompletions } = useScriptCompletionsStore();

    // Fetch completions on mount if not already loaded
    useEffect(() => {
        fetchCompletions();
    }, [fetchCompletions]);

    // Setup Monaco before mounting
    const handleBeforeMount: BeforeMount = (monaco) => {
        // Clean up previous completion provider
        if (completionDisposable) {
            completionDisposable.dispose();
        }

        // Register custom completion provider for pm.* API
        completionDisposable = monaco.languages.registerCompletionItemProvider("javascript", {
            triggerCharacters: [".", "p", "c", "t"],
            provideCompletionItems: (model: editor.ITextModel, position: IPosition) => {
                // Get fresh completions from store
                const currentCompletions = useScriptCompletionsStore.getState().completions;

                const word = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn,
                };

                // Get the text before cursor to provide context-aware completions
                const lineContent = model.getLineContent(position.lineNumber);
                const textBeforeCursor = lineContent.substring(0, position.column - 1);

                // Build suggestions with range
                let suggestions = currentCompletions.map((item) => ({
                    label: item.label,
                    kind: item.kind,
                    insertText: item.insertText,
                    insertTextRules: item.insertTextRules,
                    detail: item.detail,
                    documentation: {
                        value: item.documentation,
                        isTrusted: true,
                    },
                    sortText: item.sortText,
                    filterText: item.filterText || item.label,
                    range,
                }));

                // Context-aware filtering for better UX
                // After 'pm.', show pm.* completions
                if (textBeforeCursor.endsWith("pm.")) {
                    suggestions = suggestions.filter(
                        (s) =>
                            s.label.toString().startsWith("pm.") &&
                            s.label !== "pm"
                    );
                }
                // After 'pm.response.', show response properties/methods
                else if (textBeforeCursor.endsWith("pm.response.")) {
                    suggestions = suggestions.filter(
                        (s) =>
                            s.label.toString().startsWith("pm.response.") &&
                            s.label !== "pm.response"
                    );
                }
                // After 'pm.request.', show request properties
                else if (textBeforeCursor.endsWith("pm.request.")) {
                    suggestions = suggestions.filter(
                        (s) =>
                            s.label.toString().startsWith("pm.request.") &&
                            s.label !== "pm.request"
                    );
                }
                // After 'pm.environment.', show environment methods
                else if (textBeforeCursor.endsWith("pm.environment.")) {
                    suggestions = suggestions.filter(
                        (s) =>
                            s.label.toString().startsWith("pm.environment.") &&
                            s.label !== "pm.environment"
                    );
                }
                // After 'pm.variables.', show variables methods
                else if (textBeforeCursor.endsWith("pm.variables.")) {
                    suggestions = suggestions.filter(
                        (s) =>
                            s.label.toString().startsWith("pm.variables.") &&
                            s.label !== "pm.variables"
                    );
                }
                // After 'console.', show console methods
                else if (textBeforeCursor.endsWith("console.")) {
                    suggestions = suggestions.filter((s) =>
                        s.label.toString().startsWith("console.")
                    );
                }
                // After '.to.have.', show have.* assertions
                else if (textBeforeCursor.match(/\.to\.have\.$/)) {
                    suggestions = suggestions.filter((s) =>
                        s.label.toString().startsWith("to.have.")
                    );
                }
                // After '.to.be.', show be.* assertions
                else if (textBeforeCursor.match(/\.to\.be\.$/)) {
                    suggestions = suggestions.filter((s) =>
                        s.label.toString().startsWith("to.be.")
                    );
                }
                // After '.to.', show assertion chains
                else if (textBeforeCursor.match(/\.to\.$/)) {
                    suggestions = suggestions.filter((s) =>
                        s.label.toString().startsWith("to.")
                    );
                }
                // After expect().', show .to chain
                else if (textBeforeCursor.match(/\)\.$/)) {
                    suggestions = suggestions.filter((s) =>
                        s.label.toString().startsWith("to")
                    );
                }

                return { suggestions };
            },
        });

        // Configure JavaScript defaults
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: false,
        });

        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            target: monaco.languages.typescript.ScriptTarget.ES2020,
            allowNonTsExtensions: true,
            noLib: true,
        });

        // Add pm type definitions for better IntelliSense
        const pmTypeDefinitions = `
declare const pm: {
  test(name: string, fn: () => void): void;
  expect(value: any): {
    to: {
      not: any;
      equal(expected: any): void;
      eql(expected: any): void;
      exist: void;
      be: {
        true: void;
        false: void;
        null: void;
        undefined: void;
        ok: void;
        empty: void;
        above(n: number): void;
        below(n: number): void;
        at: {
          least(n: number): void;
          most(n: number): void;
        };
        a(type: string): void;
        an(type: string): void;
      };
      have: {
        property(name: string): void;
        length(n: number): void;
        lengthOf(n: number): void;
      };
      include(value: any): void;
      contain(value: any): void;
      match(regex: RegExp): void;
    };
  };
  response: {
    code: number;
    status: number;
    headers: Record<string, string> & {
      get(name: string): string | undefined;
      has(name: string): boolean;
    };
    json(): any;
    text(): string;
    responseTime: number;
    to: {
      have: {
        status(code: number): void;
        header(name: string): void;
        jsonBody(): void;
      };
    };
  };
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
  environment: {
    get(name: string): string | undefined;
    set(name: string, value: any): void;
  };
  variables: {
    get(name: string): any;
    set(name: string, value: any): void;
  };
};

declare const console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

declare const JSON: {
  parse(text: string): any;
  stringify(value: any, replacer?: any, space?: number): string;
};
`;
        monaco.languages.typescript.javascriptDefaults.addExtraLib(
            pmTypeDefinitions,
            "pm-api.d.ts"
        );
    };

    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;

        // Set editor options
        editor.updateOptions({
            minimap: { enabled: false },
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, Monaco, 'Courier New', monospace",
            renderWhitespace: "selection",
            automaticLayout: true,
            suggest: {
                showKeywords: true,
                showSnippets: true,
                showFunctions: true,
                showVariables: true,
                showClasses: true,
                showInterfaces: true,
                preview: true,
                previewMode: "subwordSmart",
                filterGraceful: true,
                snippetsPreventQuickSuggestions: false,
            },
            quickSuggestions: {
                other: true,
                comments: false,
                strings: true,
            },
            parameterHints: {
                enabled: true,
                cycle: true,
            },
            snippetSuggestions: "top",
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: "on",
            tabCompletion: "on",
        });
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (completionDisposable) {
                completionDisposable.dispose();
                completionDisposable = null;
            }
        };
    }, []);

    return (
        <div className="border border-gray-300 rounded overflow-hidden">
            <Editor
                height={height}
                language="javascript"
                theme="vs-light"
                value={value}
                onChange={(newValue) => onChange(newValue || "")}
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                options={{
                    minimap: { enabled: false },
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    tabSize: 2,
                    fontSize: 13,
                    automaticLayout: true,
                }}
                loading={
                    <div className="flex items-center justify-center h-full bg-gray-50">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
                    </div>
                }
            />
        </div>
    );
}
