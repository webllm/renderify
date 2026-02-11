import { createElementNode, createTextNode, type RuntimeElementNode } from "@renderify/ir";

export interface CardProps {
  title: string;
  body: string;
}

export function createCard(props: CardProps): RuntimeElementNode {
  return createElementNode("article", { class: "renderify-card" }, [
    createElementNode("h3", undefined, [createTextNode(props.title)]),
    createElementNode("p", undefined, [createTextNode(props.body)]),
  ]);
}

export function createButton(
  label: string,
  variant: "primary" | "secondary" = "primary"
): RuntimeElementNode {
  return createElementNode(
    "button",
    {
      class: `renderify-button renderify-button--${variant}`,
      type: "button",
    },
    [createTextNode(label)]
  );
}
