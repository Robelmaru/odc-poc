declare module "pdf-poppler" {
  interface ConvertOptions {
    format?: string;
    scale?: number;
    out_dir?: string;
    out_prefix?: string;
    page?: number;
  }
  export function convert(file: string, opts: ConvertOptions): Promise<string>;
  export function info(file: string): Promise<any>;
  export function imgdata(file: string): Promise<any>;
  export const path: string;
}
