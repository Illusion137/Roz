import pyttsx3
import json
import os
import glob
import subprocess
from mutagen.wave import WAVE

audio_reader = pyttsx3.init()
voices = audio_reader.getProperty('voices')
audio_reader.setProperty('voice', voices[0].id)
audio_reader.setProperty('rate', 200)

DATA_FILE_PATH = "temp/jnovel_volume.json"
AUDIO_LIST_PATH = "temp/audio_list.txt"
TIMESTAMPS_PATH = "out/timestamps.dat"
AUDIO_FOLDER_PATH = "temp/audio/*"
TEST = False

#ffmpeg -f concat -safe 0 -i list.txt -c copy output.wav
def build_audio():
    command_list = [
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", "temp/audio_list.txt", 
        "-c", "copy", 
        "out/merged.wav"
    ]
    subprocess.run(command_list)
#ffmpeg -r 1 -loop 1 -i img/cover.jpg -i output.wav -acodec copy -r 1 -shortest -vf scale=860:1223 ../out/volume.flv
def build_video():
    command_list = [
        "ffmpeg", 
        "-r", "1", 
        "-loop", "1", 
        "-i", "temp/img/cover.jpg",
        "-i", "out/merged.wav", 
        "-acodec", "copy", 
        "-r", "1", 
        "-shortest",
        "-vf", "scale=860:1223",
        "out/processed.flv"
    ]
    subprocess.run(command_list)

def timestamp_to_string(ts):
    hours = int(ts / 3600)
    minutes = int((ts - (hours * 3600)) / 60)
    seconds = ts - (hours * 3600) - (minutes * 60)
    return str(int(hours)).zfill(2) + ":" + str(int(minutes)).zfill(2) + ":" + str(int(seconds)).zfill(2)

def cleanup():
    audio_files = glob.glob(AUDIO_FOLDER_PATH)
    for f in audio_files:
        os.remove(f)
    open(AUDIO_LIST_PATH, 'w').close()
    open(TIMESTAMPS_PATH, 'w').close()
        
def process_volume():    
    chapter_titles = []
    chapter_timestamps = []

    chapter_title = ""
    section_text = ""
    section = 0
    timestamp = 0

    volume_json = {}
    with open(DATA_FILE_PATH, "r") as data_file:
        volume_json = json.loads(data_file.buffer.read())

    for part in volume_json:
        for element in part["content"]:
            update = False
            set_chapter_title = ""
            if element["type"] == "p":
                section_text += element["contents"] + " "
                pass
            elif element["type"] == "h1":
                if chapter_title == "":
                    chapter_title = element["contents"]
                    continue
                set_chapter_title = element["contents"]
                update = True
                pass
            elif element["type"] == "img":
                pass
            if TEST and update == True:
                chapter_titles.append(chapter_title)
                chapter_title = set_chapter_title
                section_text = ""
                section += 1
            elif update == True:
                print(chapter_title)
                chapter_titles.append(chapter_title)
                path = f"temp/audio/{str(section)}.wav"
                audio_reader.save_to_file(chapter_title + '\n' + section_text, path)
                chapter_title = set_chapter_title
                section_text = ""
                section += 1
                # length = WAVE(path).info.length
                # timestamp += length
    if not TEST:
        print(chapter_title)
        chapter_titles.append(chapter_title)
        path = f"temp/audio/{str(section)}.wav"
        audio_reader.save_to_file(chapter_title + '\n' + section_text, path)
        chapter_title = set_chapter_title
        section_text = ""
        section += 1                
        path =  f"temp/audio/{str(section)}.wav"
        audio_reader.save_to_file(chapter_title + '\n' + section_text, path)
        audio_reader.runAndWait()
    print(section)
    with open(AUDIO_LIST_PATH, "a") as audio_list:
        for i in range(0, section):
            path = f"audio/{str(i)}.wav"
            audio_list.writelines("file '" + path + "'\n")
    with open(TIMESTAMPS_PATH, "a") as timestamps_file:
        current_timestamp = 0;
        write_buffer = []
        for i in range(0, section):
            path = f"temp/audio/{str(i)}.wav"
            length = WAVE(path).info.length
            chapter_timestamps.append(current_timestamp)
            current_timestamp += length;
        for i in range(0, section):
            write_buffer.append(f"{str(chapter_titles[i])}: {timestamp_to_string(chapter_timestamps[i])}")
        timestamps_file.writelines('\n'.join(write_buffer))

cleanup()
process_volume()
build_audio()
build_video()

#ffmpeg -f concat -safe 0 -i list.txt -c copy output.wav
#ffmpeg -r 1 -loop 1 -i cover9.png -i ToaruNT_9 -acodec copy -r 1 -shortest -vf scale=1280:720 ToaruNT_9.flv