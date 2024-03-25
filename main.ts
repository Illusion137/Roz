import * as fs from "fs";
import puppeteer, { HTTPResponse, Page } from "puppeteer-core";
import axios from "axios";
import { JSDOM } from "jsdom";
import { spawn } from "child_process";
import {
    green,
    cyan,
    yellow,
    red,
    blue,
    magentaBright,
    italic,
    gray,
    bold,
} from "console-log-colors";
// import { PuppeteerCookie, getCookies, getCookiesPromised } from "chrome-cookies-secure";
import { SingleBar } from "cli-progress";
import * as docx from "docx";
import Pdfparser from "pdf2json";
import mammoth from "mammoth";
import say from "say";
import getAudioDurationInSeconds from "get-audio-duration";
import * as progress from "cli-progress";
import * as fsExtra from "fs-extra";
import * as http from "http";

const help_contents: string = 
green(`${gray(`--Roz powered by ${italic("The Origin Project")}--`)}

${magentaBright("roz")} ${cyan("<input>")} ${cyan("<options>")}                                                            Produces raw text file and audiobook from the given input 
${magentaBright("roz")} ${cyan("-lv")}                                                                          Lists the available downloaded voices 
Usage:

${magentaBright("roz")} ${blue("-i")} ${yellow("[webnovel|jnovel|pdf|text]")}                                                Sets input type
  ${magentaBright("roz")} ${blue("-i")} ${yellow("webnovel")} ${cyan("<web-novel-id>")} ${cyan("<range-start>")}${red("(1)")} ${cyan("<range-end>")}${red("(<range-start>)")}     Webnovel from https://ncode.syosetu.com/{web-novel-id}
  ${magentaBright("roz")} ${blue("-i")} ${yellow("jnovel")} ${cyan("<jnovel-embeded-link-start>")} ${cyan("<uuid-offset>")}${red("(0)")}                     JNovel from https://labs.j-novel.club/embed/... (must be logged into JNovel on Chrome)
  ${magentaBright("roz")} ${blue("-i")} ${yellow("pdf")} ${cyan("<pdf-file-path/url>")}                                                 PDF at {pdf-file-path}    
  ${magentaBright("roz")} ${blue("-i")} ${yellow("text")} ${cyan("<text-file-path/url>")}                                               Text file at {text-file-path}
  ${magentaBright("roz")} ${blue("-i")} ${yellow("docx")} ${cyan("<docx-file-path/url>")}                                               Text file at {text-file-path}

${magentaBright("roz")} ${cyan("<input>")} ${blue("-v")} ${cyan("<voice>")}                                                           Sets the voice for the audiobook
${magentaBright("roz")} ${cyan("<input>")} ${blue("-c")} ${cyan("<cover>")}                                                           Sets the cover image for the audiobook if not using JNovel Club
${magentaBright("roz")} ${cyan("<input>")} ${blue("-m")} ${cyan("<translation-map>")}                                                 Sets the translation-map file
${magentaBright("roz")} ${cyan("<input>")} ${blue("-a")} ${cyan("<audiobook?>")}                                                      Enables audiobook
${magentaBright("roz")} ${cyan("<input>")} ${blue("-h")} ${cyan("<hide-chapter-names?>")}                                             Hide chapter names when exporting audiobook
${magentaBright("roz")} ${cyan("<input>")} ${blue("-p")} ${cyan("<proxy?>")}                                                          Sets the use of WebNovel Proxy
${magentaBright("roz")} ${cyan("<input>")} ${blue("-t")} ${cyan("<translate?>")}                                                      Translate the Input?
${magentaBright("roz")} ${cyan("<input>")} ${blue("-e")} ${cyan("<chrome_executable_path>")}                                          Sets the chrome executable path`)

interface JNovelChapter {
    no: number;
    title: string;
    uuid: string;
    selected?: boolean;
}
interface JNovelVolume {
    chapters: JNovelChapter[];
}

//#region ILLUSIVE-ORIGIN-PROXY
namespace Origin {
    export namespace Illusive {
        export type Proxy = { ip: string; port: number };
        export function get_random_index(max: number) {
            max = Math.floor(max);
            return Math.floor(Math.random() * (max - 0) + 0); // The maximum is exclusive and the minimum is inclusive
        }

        export async function get_proxy_list(): Promise<Proxy[]> {
            try {
                const IPPortRegex = /((\d+\.)+(\d+)):(\d+)/g;
                const body: string = (
                    await axios({
                        method: "GET",
                        url: "https://www.us-proxy.org/",
                    })
                ).data;

                const matchedProxies = [...body.matchAll(IPPortRegex)];
                const proxies = [];
                for (let i = 0; i < matchedProxies.length; i++) {
                    proxies.push({
                        ip: matchedProxies[i][1],
                        port: parseInt(matchedProxies[i][4]),
                    });
                }
                return proxies;
            } catch (error) {
                return [];
            }
        }
    }
}
//#endregion

const options = {
    chrome_executable_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    proxy: false,
    translate: false,
    audiobook: false,
    hide_chapter_names: false,
    cover: "temp/img/cover.jpg",
    translation_map_path: null,
    voice: null,
    speed: 1,
    pdf_margin: [0, 48],
    pdf_start: 0
};

async function get_uuids(main_page: Page): Promise<string[]> {
    const url = main_page.url();
    const cuuid = url.replace("https://labs.j-novel.club/embed/", '');
    
    await main_page.waitForNetworkIdle();
    const data_toc_json: JNovelVolume[] = await main_page.evaluate(() => {
        const data_toc = document
            .querySelector("body")
            ?.getAttribute("data-toc") as string;
        const data_toc_json = JSON.parse(data_toc);
        return data_toc_json;
    });
    //Get latest chapter UUIDS
    //Substract more for different volumes: -1 == latest volume
    fs.writeFileSync("temp/docs/jnovel-toc.json", JSON.stringify(data_toc_json));
    const index = data_toc_json.findIndex(volume => volume.chapters.findIndex(chapter => chapter.uuid === "65dcd648cb5d7e876e6d2cef") != -1);
    const volume_parts: JNovelChapter[] = data_toc_json[index].chapters;
    const volume_part_uuids: string[] = [];
    for (const volume_part of volume_parts)
        if (volume_part.selected != true)
            volume_part_uuids.push(volume_part.uuid);
    return volume_part_uuids;
}

async function parse_part(part_page: Page): Promise<string> {
    const rtxt: string = await part_page.evaluate(() => {
        let content: string = "";
        let first = true;

        const sections = document.querySelectorAll(".br-section");
        for (let i = 0; i < sections.length - 1; i++) {
            const elements = sections[i].children;
            for (const element of elements) {
                switch (element.nodeName) {
                    case "IMG": break; //Ignore for now
                    case "H1":
                        if(!first) content += "[------------------------------------------------]" + "\r\n";
                        else first = false;
                        content += element.textContent as string + '\r\n'
                        break;
                    case "P":
                        content += element.textContent as string + '\r\n'
                        break;
                    default: log_error("Unknown: " + element.nodeName); process.exit(1);
                }
            }
        }
        return content;
    });
    return rtxt;
}

async function parse_jnovel(entry_point_url: string): Promise<string> {
    const sprogress_bar: SingleBar = new SingleBar({
        format:
            "Preload |" +
            cyan("{bar}") +
            "| {percentage}%",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
    });
    const jprogress_bar: SingleBar = new SingleBar({
        format:
            "JNovel Progress |" +
            cyan("{bar}") +
            "| {percentage}% || {value}/{total} Parts",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
    });
    sprogress_bar.start(4, 0);
    const BASE_URL = "https://labs.j-novel.club/embed/";
    const jparts: string[] = [];
    const cookies = [
        {
            "name": "__stripe_mid",
            "value": "e071e076-4a2c-442d-89b7-2113e3ae32a424de6c",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "device",
            "value": "01HP864XJ46DMZYVPE272NXQBF",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "access_token",
            "value": "s%3Ad0FtpXQq0XNNmufhcfkEWx6aVZhgAr2DRa2jumahNXTBescvi1PfGtW907MaFYiW.UAlris02lkyrJq5HStU4W4MyizKIrjs7RMwmGonvDEU",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "userId",
            "value": "s%3A65c6c12d402b76e824a6d9b0.XRP9QvOfqtP6Zmf3hRw%2Byo1q1v2cP4N7yIABQMwxlB0",
            "domain": "labs.j-novel.club"
        }
    ]
    sprogress_bar.increment();
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: options.chrome_executable_path,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        // args:['--user-data-dir="=%userprofile%\\AppData\\Local\\Chrome\\User Data']
        
        // userDataDir: "C:\\Users\\raygo\\AppData\\Local\\Google\\Chrome\\User Data\\"
    });
    sprogress_bar.increment();
    const page = await browser.newPage();
    sprogress_bar.increment();

    await page.setCookie(...cookies);
    await page.goto(entry_point_url);
    await page.setViewport({ width: 1080, height: 1024 });

    const uuids: string[] = await get_uuids(page);
    
    sprogress_bar.increment();
    log_info("Found UUIDS:" + JSON.stringify(uuids));
    console.log();
    
    jprogress_bar.start(uuids.length + 1, 0);
    
    jparts.push(await parse_part(page));
    jprogress_bar.increment();

    for (const uuid of uuids) {
        const page = await browser.newPage();
        await page.setCookie(...cookies);
        await page.goto(BASE_URL + uuid);
        await page.setViewport({ width: 1080, height: 1024 });
        await page.waitForNetworkIdle({ idleTime: 3000 });
        jparts.push(await parse_part(page));
        jprogress_bar.increment();
    }

    console.log();
    await browser.close();
    return jparts.join(chapter_break());
}

function image_break(img_src: string) {
    return `[========${img_src}========]` + "\r\n";
} // [16]
function chapter_break() {
    return "[------------------------------------------------]" + "\r\n";
} // [48]

async function google_translate_buffer_to_rtxt(buffer: Buffer): Promise<string> {
    console.log("INFO_HERE")
    const extraction_regex = /\[\[.+?\]\].+?\]\]/;
    const extract_json_string: string = extraction_regex.exec(
        buffer.toString(),
    )[0];
    const extracted: object = JSON.parse(extract_json_string);
    const base64_data: string = JSON.parse(extracted[0][2])[0][0];


    const base64_buffer = Buffer.from(base64_data, "base64");

    fs.writeFileSync("temp/docs/extracted.dat", base64_data);
    fs.writeFileSync("temp/docs/buffer.docx", base64_buffer);
    
    const rtxt = await doc_path_to_rtxt("temp/docs/buffer.docx");
    return rtxt;
}

async function translate_document(document: docx.Document | string) {
    const temp_translate_file_path =
        typeof document == "string" ? document : "temp/downloads/translate.docx";
    if (typeof document != "string")
        fs.writeFileSync(temp_translate_file_path, await docx_buffer(document));

    const browser = await puppeteer.launch({
        // devtools: true,
        ignoreDefaultArgs: ['--enable-automation'],
        headless: false,
        channel: 'chrome',
        // args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: options.chrome_executable_path,
    });
    const page = await browser.newPage();
    let res: HTTPResponse = null;

    await page.goto("https://translate.google.com/?sl=ja&tl=en&op=docs");
    await page.waitForNetworkIdle();

    // const [fileChooser] = await Promise.all([
        // page.waitForFileChooser(),
        // page.click('input[type=file]'),
    // ]);
    // await fileChooser.accept(["temp/docs/translate.docx"]);

    const upload_file_handle = await page.$("input[type=file]");
    await upload_file_handle.uploadFile("temp/docs/translate.docx");
    await page.waitForNetworkIdle();

    //Translate Button
    await page.waitForSelector("button[jsname=vSSGHe]");
    const promise = new Promise((resolve, reject) => {
        page.on("response", async (response) => {
            if (response.url().includes("batchexecute")) {
                res = response;
                fs.writeFileSync('temp/docs/translate-response-buffer.txt', await res.buffer());
                resolve(0);
            }
        });
    });
    await page.waitForNetworkIdle();
    await page.click("button[jsname=vSSGHe]");
https://translate.google.com/?sl=ja&tl=en&op=docs
    await page.waitForNetworkIdle();
    await promise;
    await page.waitForNetworkIdle();
    await page.waitForSelector("button[jsname=hRZeKc]");
    await page.click("button[jsname=hRZeKc]");
    await delay(30000);
    await browser.close();
    console.log(res.ok());
    return google_translate_buffer_to_rtxt(await res.buffer());
}

const delay = millis => new Promise((resolve, reject) => {
    setTimeout(_ => resolve(0), millis)
});

async function docx_buffer(document: docx.Document) {
    return await docx.Packer.toBuffer(document);
}

function rtxt_to_docx(rtxt: string): docx.Document {
    const sections: docx.ISectionOptions[] = [];
    const runs: docx.ParagraphChild[] = [];
    for(const paragraph of rtxt.split('\r\n')){
        // console.log(0)
        runs.push(new docx.TextRun({'text': paragraph + '\r\n', 'break': 1}));

        // sections.push({ children: [
        //     new docx.Paragraph({
        //         'text': paragraph + '\r\n',
        //     })]
        // });
    }
    sections.push({ children: [
        new docx.Paragraph({
            'children': runs,
        })] 
    });
    return new docx.Document({ 
        'creator': "Sudo",
        'title': "Silly Docx",
        'description': "", 
        'sections': sections,
    });
}
async function doc_path_to_rtxt(document_path: string) {
    const buffer = fs.readFileSync(document_path);
    const result = await mammoth.extractRawText({ buffer });
    return result.value.replace(/\r\n\r\n\r\n/g, "\r\n");
}
async function docx_to_rtxt(document: docx.Document) {
    const buffer = await docx_buffer(document);
    const result = await mammoth.extractRawText({ buffer });
    return result.value.replace(/\r\n\r\n\r\n/g, "\r\n");
}

async function parse_webnovel_chapter(web_novel_id: string, chapter: number, proxy: Origin.Illusive.Proxy = undefined, progress_bar: SingleBar = undefined) {
    let contents_jp = "";
    const response = await axios.get(
        `https://ncode.syosetu.com/${web_novel_id}/${chapter}/`,
        {
            proxy:
                proxy == undefined
                    ? undefined
                    : { protocol: "http", host: proxy.ip, port: proxy.port },
        },
    );
    const dom = new JSDOM(response.data);
    const chapter_title_jp =
        dom.window.document.querySelector(".novel_subtitle").textContent;
    const lines_of_text =
        dom.window.document.querySelector("#novel_honbun").children;

    contents_jp += chapter_title_jp + "\r\n";
    for (const line_of_text of lines_of_text)
        contents_jp += line_of_text.textContent + "\r\n";
    if (progress_bar != undefined) progress_bar.increment();
    return contents_jp;
}

async function parse_webnovel(web_novel_id: string, range_start: number, range_end: number): Promise<string> {
    if (web_novel_id == undefined) return undefined;
    if (Number.isNaN(range_start)) range_start = 1;
    if (Number.isNaN(range_end)) range_end = range_start;
    const progress_bar: SingleBar = new SingleBar({
        format:
            "WebNovel Progress |" +
            cyan("{bar}") +
            "| {percentage}% || {value}/{total} Chapters",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        hideCursor: true,
    });

    let total_contents_jp = "";

    progress_bar.start(range_end - range_start + 1, 0);

    let proxies = options.proxy ? await Origin.Illusive.get_proxy_list() : [];
    if (proxies.length > 0) {
        const promises = [];

        for (let i = range_start; i <= range_end; i++)
            promises.push(
                parse_webnovel_chapter(
                    web_novel_id,
                    i,
                    proxies[
                        Origin.Illusive.get_random_index(proxies.length - 1)
                    ],
                    progress_bar,
                ),
            );
        const chapters = await Promise.all(promises);
        total_contents_jp = chapters.join(chapter_break());
    } else {
        const chapters = [];
        for (let i = range_start; i <= range_end; i++) {
            chapters.push(await parse_webnovel_chapter(web_novel_id, i));
            progress_bar.increment();
        }
        total_contents_jp = chapters.join(chapter_break());
    }

    console.log();
    // fs.writeFileSync("temp/docs/text-content.roz.jp.txt", total_contents_jp);
    return total_contents_jp;
}

function is_url(test_url: string) {
    const test =
        /^((https?|ftp|smtp):\/\/)?(www.)?[a-z0-9]+\.[a-z]+(\/[a-zA-Z0-9#]+\/?)*$/;
    return test.test(test_url);
}
async function parse_pdf(file_path_or_url: string): Promise<string> {
    const dpath = "temp/downloads/t.pdf";
    if(is_url(file_path_or_url)){
        file_path_or_url = dpath;
        const file = fs.createWriteStream(dpath);
        const request = new Promise((resolve, reject) => {
            http.get(file_path_or_url, function(response) {
                // response.pipe(file);
                resolve(0);
            });
        });
        await request;
    }
    let rtxt_content = "";
    const parser = new Pdfparser();
    const promise = new Promise((resolve, reject) => {parser.on("pdfParser_dataReady", (data) => {
        for(const page of data.Pages.slice(options.pdf_start)){
            for (const t of page.Texts) {
                for (const r of t.R) {
                    if (t.y > options.pdf_margin[0] && t.y < options.pdf_margin[1]) {
                        const txt = decodeURIComponent(r.T)
                        // rtxt
                        if(txt === null){
                            rtxt_content += chapter_break();
                        }
                        rtxt_content += txt + '\r\n';
                    }
                }
            }
        }
        fs.writeFileSync("temp/docs/pdf.json", JSON.stringify(data));
        resolve(0);
        });
    });
    await parser.loadPDF(file_path_or_url);
    await promise;
    return rtxt_content;
}
async function read_text(file_path_or_url: string): Promise<string> {
    const dpath = "temp/downloads/t.txt";
    if(is_url(file_path_or_url)){
        file_path_or_url = dpath;
        const file = fs.createWriteStream(dpath);
        const request = new Promise((resolve, reject) => {
            http.get(file_path_or_url, function(response) {
                // response.pipe(file);
                resolve(0);
            });
        });
        await request;
    }
    return fs.readFileSync(file_path_or_url, 'utf-8');
}

//Part 5 Volume 10
//https://ncode.syosetu.com/n4830bu/637/
// parse_webnovel("n4830bu", 636, 649); // Volume 10 LN

/*
main(
    "https://labs.j-novel.club/embed/65dcd648cb5d7e876e6d2cef", // Entry Point Url
    [
        {
            "name": "__stripe_mid",
            "value": "e071e076-4a2c-442d-89b7-2113e3ae32a424de6c",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "device",
            "value": "01HP864XJ46DMZYVPE272NXQBF",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "access_token",
            "value": "s%3Ai5200m9Y3vLedzf9rJgBJHpfRBnSSJ9w9jQ8o2z8nFYAdVhOo8vgABtRVhdQNCr4.RKOTGasHGquwAx4%2FPpBoMl%2BsuoxvI71OHGWp6%2FJ%2B1ew",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "userId",
            "value": "s%3A65c6c12d402b76e824a6d9b0.XRP9QvOfqtP6Zmf3hRw%2Byo1q1v2cP4N7yIABQMwxlB0",
            "domain": "labs.j-novel.club"
        },
        {
            "name": "__stripe_sid",
            "value": "037f2ff7-8e02-457b-a4cf-07fbbbcb27e4c947a8",
            "domain": "labs.j-novel.club"
        }
    ]
);
*/

type TimestampedChapter = { title: string; timestamp: string };
function timestamp_to_string(t_seconds: number) {
    const hours = Math.floor(t_seconds / 3600);
    const minutes = Math.floor((t_seconds - hours * 3600) / 60);
    const seconds = t_seconds - hours * 3600 - minutes * 60;
    return (
        String(Math.floor(hours)).padStart(2, "0") +
        ":" +
        String(Math.floor(minutes)).padStart(2, "0") +
        ":" +
        String(Math.floor(seconds)).padStart(2, "0")
    );
}

async function get_voices(): Promise<string[]> {
    let vlist: string[] = [];
    const promise = new Promise((resolve, reject) => {
        say.getInstalledVoices((err, voices) => {
        vlist = voices;
        resolve(0);
        });
    });
    await promise;
    return vlist;
}

async function build_audio(){
    const arg_list = [
        "-f", "concat",
        "-safe", "0",
        "-i", "temp/audio_list.txt", 
        "-c", "copy", 
        "out/merged.wav"
    ]
    const promise = new Promise((resolve, reject) => {
        const merge_audio = spawn("ffmpeg", arg_list, {'stdio': 'overlapped'});
        merge_audio.on('close', (code) => {
            if(code == 0)
                log_info(`Merge-Audio closed with code ${code}`);
            else
                log_error(`Merge-Audio closed with code ${code}`);
            resolve(0);
        });
        merge_audio.on('exit', (code) => {
            if(code == 0)
                log_info(`Merge-Audio exited with code ${code}`);
            else
                log_error(`Merge-Audio exited with code ${code}`);
        }); 
        merge_audio.on('disconnect', () => {
            log_warn('Merge-Audio disconnected');
        }); 
        merge_audio.on('spawn', () => {
            log_info('Merging Audio')
        });
        merge_audio.on('message', (msg) => {
            log_info(msg.toString())
        });
    });
    await promise;
}
async function build_video(){
    const arg_list = [
        "-r", "1", 
        "-loop", "1", 
        "-i", options.cover,
        "-i", "out/merged.wav", 
        "-acodec", "copy", 
        "-r", "1", 
        "-shortest",
        "-vf", "scale=860:1223",
        "out/processed.flv"
    ]
    const promise = new Promise((resolve, reject) => {
        const merge_video = spawn("ffmpeg", arg_list, {'stdio': 'overlapped'});
        merge_video.on('close', (code) => {
            if(code == 0)
                log_info(`Merge-Video closed with code ${code}`);
            else
                log_error(`Merge-Video closed with code ${code}`);
            resolve(0);
        });
        merge_video.on('exit', (code) => {
            if(code == 0)
                log_info(`Merge-Video exited with code ${code}`);
            else
                log_error(`Merge-Video exited with code ${code}`);
        }); 
        merge_video.on('disconnect', () => {
            log_warn('Merge-Video disconnected');
        }); 
        merge_video.on('spawn', () => {
            log_info('Merging Video')
        });
        merge_video.on('message', (msg) => {
            log_info(msg.toString())
        });
    });
    await promise;
}
async function rtxt_to_audiobook(content: string) {
    // fsExtra.emptyDirSync("temp/audio/");
    // fsExtra.emptyDirSync("temp/img/");
    // fsExtra.emptyDirSync("temp/docs/");
    const timestamps: TimestampedChapter[] = [];
    const ff_file_list: string[] = [];
    let current_durration = 0;
    let t = 0;
    log_info(`Total Chapters: ${content.split(chapter_break()).length}`)
    for (const chapter of content.split(chapter_break()) ) {
        const lines = chapter.split("\r\n");
        const title = lines[0];
        const ff_file_path = `temp/audio/${t++}.wav`;
        ff_file_list.push('file ../' + ff_file_path);

        timestamps.push({
            title: title,
            timestamp: timestamp_to_string(current_durration),
        });
        if(options.hide_chapter_names) 
            log_info(`Exporting Chapter ${t} -> ${italic(title.replace(/[^ ]/g, '*'))}`);
        else 
            log_info(`Exporting Chapter ${t} -> ${italic(title)}`);
        const promise = new Promise((resolve, reject) => {
            // console.log(chapter);
            say.export(
                chapter,
                options.voice,
                options.speed,
                ff_file_path,
                (err) => {
                    if (err) log_error(err);
                    resolve(0);
                },
            );
        });
        await promise;
        current_durration += await getAudioDurationInSeconds(ff_file_path, "C:\\ffmpeg\\bin\\ffprobe.exe");
    }

    const f_timestamps = timestamps
        .map((t) => `${t.title}: ${t.timestamp}`)
        .join("\r\n");
    fs.writeFileSync("out/timestamps.dat", f_timestamps);
    fs.writeFileSync("temp/audio_list.txt", ff_file_list.join('\r\n'));
    await build_audio();
    await build_video();
}

function args_to_opts(argv: string[]) {
    const opts: string[][] = [];
    for (let i = 2, o = -1; i < argv.length; i++)
        if (argv[i][0].startsWith("-")) {
            opts.push([argv[i]]);
            o++;
        } else opts[o].push(argv[i]);
    return opts;
}
function log_info(str: any) {
    console.log(cyan(`${bold("[INFO]:")} ${str}`));
}
function log_warn(str: any) {
    console.log(yellow(`${bold("[WARN]:")} ${str}`));
}
function log_error(str: any) {
    console.log(red(`${bold("[ERROR]:")} ${str}`));
}
function log_input_error(error: string, slice_start = 6, slice_end = 11) {
    log_error(error);
    console.log(
        help_contents.split("\n").slice(slice_start, slice_end).join("\n"),
    );
}

async function main() {
    const opts: string[][] = args_to_opts(process.argv);
    options.voice = (await get_voices())[0];

    if (opts.findIndex((opt) => opt[0] == "-t") != -1) options.translate = true;
    if (opts.findIndex((opt) => opt[0] == "-p") != -1) options.proxy = true;
    if (opts.findIndex((opt) => opt[0] == "-a") != -1) options.audiobook = true;
    if (opts.findIndex((opt) => opt[0] == "-h") != -1) options.hide_chapter_names = true;
    let hold = -1;
    if ((hold = opts.findIndex((opt) => opt[0] == "-v")) != -1) options.voice = opts[hold][1];
    if ((hold = opts.findIndex((opt) => opt[0] == "-c")) != -1) options.cover = opts[hold][1];
    if ((hold = opts.findIndex((opt) => opt[0] == "-m")) != -1) options.translation_map_path = opts[hold][1];
    
    if (opts.length == 0) {
        console.log(help_contents);
    } else if (opts[0][0] == "-lv") {
        say.getInstalledVoices((err, voices) => {
            console.log( green(bold("Installed Voices:\n") + italic(voices.join("\n"))) );
            console.log(bold(red(err)));
        });
        console.log(await get_voices());
    } else if (opts[0][0] == "-i") {
        fsExtra.emptyDirSync("temp/downloads/");
        // [webnovel|jnovel|pdf|text]
        if (opts[0].slice(1).length < 1) { log_input_error("<---- No Input Type provided ---->"); return; }

        const input_type = opts[0][1];
        const opt_in = opts[0].slice(1);

        let rtext_content: string;
        switch (input_type) {
            case "text": {
                if (opt_in.length < 2) { log_input_error("<---- Not enough arguments provided ---->", 10, 11); return; }
                rtext_content = await read_text(opt_in[1]);
                break;
            }
            case "docx": {
                if (opt_in.length < 2) { log_input_error("<---- Not enough arguments provided ---->", 11, 12); return; }
                rtext_content = await doc_path_to_rtxt(opt_in[1]);
                break;
            }
            case "pdf": {
                if (opt_in.length < 2) { log_input_error("<---- Not enough arguments provided ---->", 9, 10); return; }
                rtext_content = await parse_pdf(opt_in[1]);
                break;
            }
            case "webnovel": {
                if (opt_in.length < 2) { log_input_error("<---- Not enough arguments provided ---->", 7, 8); return; }

                const web_novel_id = opt_in[1];
                const range_start = parseInt(opt_in[2]);
                const range_end = parseInt(opt_in[3]);

                if (!/(\w|\d){5,}/.test(web_novel_id)) { log_input_error("<---- Invalid Web-Novel ID ---->", 7, 8); return; }
                if (range_start < -1) { log_input_error("<---- Range-Start must be >= 1 ---->", 7, 8); return; }
                if (range_end < -1) { log_input_error("<---- Range-End must be >= 1 ---->", 7, 8); return; }
                if (range_end < range_start) { log_input_error("<---- Range-End must be >= Range-Start ---->", 7, 8); return; }
                rtext_content = await parse_webnovel(web_novel_id, range_start, range_end);
                break;
            }
            case "jnovel": {
                if (opt_in.length < 2) { log_input_error("<---- Not enough arguments provided ---->", 8, 9); return; }
                rtext_content = await parse_jnovel(opt_in[1]); 
                break;
            }
            default:
                log_error(`Unknown input-type: "${italic(input_type)}"`);
                process.exit(1);
        }
        if (rtext_content != undefined) {
            log_info("Read Data");
            fsExtra.emptyDirSync("out/");
            if(options.translate){
                log_info("Translating");
                fs.writeFileSync("temp/docs/translate.roz.txt", rtext_content);
                // fs.writeFileSync("temp/docs/translate.roz.docx", await docx_buffer(rtxt_to_docx(rtext_content)));
            }
            else{
                rtext_content = rtext_content
                    .replace(/(”|“)/g, "\"")
                    .replace(/’/g, '\'')
                    .replace(/``/g, '"')
                    .replace(/ ?… ?/g, '...')
                    .replace(/ ?\.\.\. ?/g, '...')
                    .replace(/''/g, '"')
                    .replace(/\r\n\r\n\r\n\r\n/g, '\r\n\r\n');
                rtext_content = rtext_content.replace(/[^\x00-\x7F]+/g, ' ');

                if(options.translation_map_path) {
                    const translation_file = fs.readFileSync(options.translation_map_path, 'utf-8');
                    const translation_map = translation_file.split('\r\n').map(line => { return line.split(' -> ') });
                    for(const translation_mapping of translation_map){
                        const key = translation_mapping[0]
                        const value = translation_mapping[1];
                        const regex = new RegExp(key,'gi');
                        rtext_content = rtext_content.replace(regex, value);
                    }
                }
                fs.writeFileSync("out/processed.roz.txt", rtext_content);
                fs.writeFileSync("out/processed.roz.docx", await docx_buffer(rtxt_to_docx(rtext_content)));

                if(options.audiobook) {
                    await rtxt_to_audiobook(rtext_content);
                }
            }
        } else {
            log_error("Undefined RText-Content");
            process.exit(1);
        }
    }
}

// main().then(() => process.exit());
main();
//ts-node main.ts -i webnovel n4830bu 652 668 -t