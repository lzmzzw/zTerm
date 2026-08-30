// Author: Liz
import featureCss from "../styles/features.css?raw";
import primitiveCss from "../styles/primitives.css?raw";
import responsiveCss from "../styles/responsive.css?raw";
import shellCss from "../styles/shell.css?raw";
import tokenCss from "../styles/tokens.css?raw";
import indexCss from "../index.css?raw";

export const globalCssEntrySource = indexCss;
export const globalCssSource = [tokenCss, primitiveCss, shellCss, featureCss, responsiveCss].join("\n");
