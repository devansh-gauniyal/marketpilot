import { githubMdxConnector } from "../../connectors";

export type ScanAltTextGapsInput = {
  paths?: string[];
  maxFiles?: number;
};

export type ScanAltTextGapsOutput = {
  success: boolean;
  result: string;
  gaps: {
    filepath: string;
    imageSrc: string;
    line: number;
  }[];
};

export async function scanAltTextGaps(
  input: ScanAltTextGapsInput,
): Promise<ScanAltTextGapsOutput> {
  if (!githubMdxConnector.capabilities.canScanSource) {
    return {
      success: false,
      result: "GitHub-MDX connector does not advertise canScanSource.",
      gaps: [],
    };
  }

  if (!githubMdxConnector.scanAltTextGaps) {
    return {
      success: false,
      result: "GitHub-MDX connector has no scanAltTextGaps method.",
      gaps: [],
    };
  }

  const gaps = await githubMdxConnector.scanAltTextGaps({
    paths: input.paths,
    maxFiles: input.maxFiles,
  });

  if (gaps.length === 0) {
    return {
      success: true,
      result: "No source image tags with missing alt text were found.",
      gaps,
    };
  }

  const lines = gaps.map(
    (gap) => `- ${gap.filepath}:${gap.line} :: ${gap.imageSrc}`,
  );

  return {
    success: true,
    result: [
      `Found ${gaps.length} source image tag(s) missing alt text.`,
      "Use these exact filepath and imageSrc values when calling add_alt_text:",
      ...lines,
    ].join("\n"),
    gaps,
  };
}
