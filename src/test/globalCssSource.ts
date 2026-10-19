import design0 from "../styles/design.css?raw";
import design1 from "../styles/design-shell.css?raw";
import design2 from "../styles/design-connections.css?raw";
import design3 from "../styles/design-files.css?raw";
import design4 from "../styles/design-tools.css?raw";
// Author: Liz
import featureCss from "../styles/features.css?raw";
import primitiveCss from "../styles/primitives.css?raw";
import responsiveCss from "../styles/responsive.css?raw";
import shellCss from "../styles/shell.css?raw";
import tokenCss from "../styles/tokens.css?raw";
import indexCss from "../index.css?raw";

export const globalCssEntrySource = indexCss;
export const globalCssSource = [tokenCss, primitiveCss, shellCss, featureCss, responsiveCss, design0, design1, design2, design3, design4].join("\n");
