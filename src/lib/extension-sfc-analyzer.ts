import {
  ElementTypes,
  NodeTypes,
  parse as parseTemplate,
  type AttributeNode,
  type DirectiveNode,
  type ElementNode,
  type RootNode,
  type TemplateChildNode,
} from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';

import type {
  ExtensionSfcAnalysis,
  ExtensionSfcAttributeAnalysis,
  ExtensionSfcElementAnalysis,
} from './types.js';

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

function staticExpressionContent(node: DirectiveNode['arg'] | DirectiveNode['exp']): string | null {
  if (!node || node.type !== NodeTypes.SIMPLE_EXPRESSION) return null;
  return node.content;
}

function analyzeAttribute(prop: AttributeNode | DirectiveNode): ExtensionSfcAttributeAnalysis {
  if (prop.type === NodeTypes.ATTRIBUTE) {
    return {
      name: prop.name,
      directive: null,
      value: prop.value?.content ?? null,
      dynamicArgument: false,
      modifiers: [],
    };
  }
  const argument = staticExpressionContent(prop.arg);
  return {
    name: argument || prop.name,
    directive: prop.name,
    value: staticExpressionContent(prop.exp),
    dynamicArgument: Boolean(prop.arg && prop.arg.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic),
    modifiers: prop.modifiers.map((modifier) => modifier.content),
  };
}

function descendantText(node: TemplateChildNode): string {
  if (node.type === NodeTypes.TEXT) return node.content;
  if (node.type === NodeTypes.INTERPOLATION) return '';
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => descendantText(child as TemplateChildNode)).join(' ');
  }
  return '';
}

function collectElements(root: RootNode): ExtensionSfcElementAnalysis[] {
  const elements: ExtensionSfcElementAnalysis[] = [];
  const visit = (node: TemplateChildNode) => {
    if (node.type === NodeTypes.ELEMENT) {
      const element = node as ElementNode;
      if (element.tagType !== ElementTypes.TEMPLATE) {
        const attributes = element.props.map(analyzeAttribute);
        const classValue = attributes.find((attribute) => attribute.directive === null && attribute.name === 'class')?.value || '';
        elements.push({
          tag: element.tag,
          attributes,
          classes: classValue.split(/\s+/).filter(Boolean),
          source: element.loc.source.slice(0, 240),
          text: element.children.map((child) => descendantText(child)).join(' ').replace(/\s+/g, ' ').trim(),
        });
      }
      for (const child of element.children) visit(child);
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child as TemplateChildNode);
    }
  };
  for (const child of root.children) visit(child);
  return elements;
}

export function analyzeExtensionSfc(code: unknown): ExtensionSfcAnalysis {
  const source = String(code || '');
  const errors: string[] = [];
  const firstTag = source.match(/^\s*<([A-Za-z][\w.-]*)\b/)?.[1]?.toLowerCase();
  const isTemplateFragment = Boolean(firstTag && !['template', 'script', 'style'].includes(firstTag));
  if (isTemplateFragment) {
    let root: RootNode | null = null;
    try {
      root = parseTemplate(source, {
        comments: false,
        onError: (error) => errors.push(errorMessage(error)),
      });
    } catch (error) {
      errors.push(errorMessage(error));
    }
    return {
      valid: errors.length === 0,
      hasTemplate: true,
      errors: Array.from(new Set(errors)),
      elements: root ? collectElements(root) : [],
    };
  }
  const parsed = parseSfc(source, {
    filename: 'EnfyraExtension.vue',
    sourceMap: false,
  });
  errors.push(...parsed.errors.map(errorMessage));
  const template = parsed.descriptor.template;
  if (!template) {
    if (/<template\b/i.test(source) && errors.length === 0) errors.push('Vue SFC template block could not be parsed.');
    return {
      valid: errors.length === 0,
      hasTemplate: false,
      errors,
      elements: [],
    };
  }

  let root: RootNode | null = null;
  try {
    root = parseTemplate(template.content, {
      comments: false,
      onError: (error) => errors.push(errorMessage(error)),
    });
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return {
    valid: errors.length === 0,
    hasTemplate: true,
    errors: Array.from(new Set(errors)),
    elements: root ? collectElements(root) : [],
  };
}

export function extensionElementHasAttribute(
  element: ExtensionSfcElementAnalysis,
  name: string,
  directive?: string | null,
): boolean {
  return element.attributes.some((attribute) => (
    attribute.name === name && (directive === undefined || attribute.directive === directive)
  ));
}

export function extensionElementAttributeValue(
  element: ExtensionSfcElementAnalysis,
  name: string,
  directive?: string | null,
): string | null {
  return element.attributes.find((attribute) => (
    attribute.name === name && (directive === undefined || attribute.directive === directive)
  ))?.value ?? null;
}
