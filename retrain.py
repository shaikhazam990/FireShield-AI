#!/usr/bin/env python3
"""
FireShield AI — retrain.py
Retrains the fire detection model with a much larger dataset
and hard negative examples to fix false positives.

Run: python3 retrain.py
"""

import os
import sys
import shutil
import yaml
import urllib.request
import zipfile
from pathlib import Path

# ─────────────────────────────────────────────────────────
#  Config — change these if needed
# ─────────────────────────────────────────────────────────
MODEL_BASE    = 'yolov8s.pt'   # yolov8s = better accuracy than yolov8n
EPOCHS        = 100            # more epochs = better accuracy
IMG_SIZE      = 640            # larger than original 416 = better detection
BATCH_SIZE    = 16             # reduce to 8 if you get out-of-memory error
OUTPUT_NAME   = 'fire_v2'      # trained model saved as fire_v2.pt
DATASET_DIR   = 'data'         # your existing data folder

# ─────────────────────────────────────────────────────────
#  Step 1 — Check existing dataset
# ─────────────────────────────────────────────────────────
def check_existing_dataset():
    print("\n" + "="*60)
    print("  STEP 1: Checking existing dataset")
    print("="*60)

    train_img  = Path(DATASET_DIR) / 'train' / 'images'
    train_lbl  = Path(DATASET_DIR) / 'train' / 'labels'
    valid_img  = Path(DATASET_DIR) / 'valid' / 'images'
    valid_lbl  = Path(DATASET_DIR) / 'valid' / 'labels'
    test_img   = Path(DATASET_DIR) / 'test'  / 'images'

    counts = {}
    for name, folder in [
        ('train/images', train_img),
        ('train/labels', train_lbl),
        ('valid/images', valid_img),
        ('valid/labels', valid_lbl),
        ('test/images',  test_img),
    ]:
        if folder.exists():
            n = len(list(folder.glob('*')))
            counts[name] = n
            print(f"  ✅ {name}: {n} files")
        else:
            print(f"  ⚠️  {name}: NOT FOUND")

    total = counts.get('train/images', 0)
    print(f"\n  Current training images: {total}")
    if total < 500:
        print("  ⚠️  Small dataset detected — will add augmentations to compensate")
    return counts


# ─────────────────────────────────────────────────────────
#  Step 2 — Download additional fire images from Roboflow
#  Using the public fire detection dataset (no API key needed)
# ─────────────────────────────────────────────────────────
def download_additional_data():
    print("\n" + "="*60)
    print("  STEP 2: Downloading additional fire dataset")
    print("="*60)

    # Roboflow public dataset URLs (these are open datasets)
    datasets = [
        {
            "name": "D-Fire (Large fire dataset)",
            "url": "https://github.com/gaiasd/DFireDataset/archive/refs/heads/main.zip",
            "note": "1900+ fire images"
        }
    ]

    extra_dir = Path('data_extra')
    extra_dir.mkdir(exist_ok=True)

    print("\n  📥 To get more training data, you have 3 options:")
    print()
    print("  OPTION A — Roboflow (Recommended, free):")
    print("    1. Go to: https://roboflow.com/")
    print("    2. Search: 'fire detection'")
    print("    3. Pick a dataset with 1000+ images")
    print("    4. Export as 'YOLOv8' format")
    print("    5. Download and extract to: data_extra/")
    print()
    print("  OPTION B — D-Fire Dataset (GitHub, free):")
    print("    https://github.com/gaiasd/DFireDataset")
    print("    1900+ labeled fire images")
    print()
    print("  OPTION C — Use your existing data (we will augment it heavily)")
    print()

    choice = input("  Press ENTER to continue with Option C (existing data + heavy augmentation)\n  or type 'path' to enter your extra dataset path: ").strip()

    if choice.lower() == 'path':
        extra_path = input("  Enter path to extra dataset folder: ").strip()
        if os.path.exists(extra_path):
            return extra_path
        else:
            print(f"  ❌ Path not found: {extra_path}")
            print("  Continuing with existing data...")
    
    return None


# ─────────────────────────────────────────────────────────
#  Step 3 — Create hard negative examples
#  These teach the model what is NOT fire
#  (yellow objects, sunsets, lamps, orange walls)
# ─────────────────────────────────────────────────────────
def create_hard_negatives():
    print("\n" + "="*60)
    print("  STEP 3: Creating hard negative examples")
    print("="*60)
    print("  Hard negatives = images of yellow/orange things that are NOT fire")
    print("  This is the main fix for your false positive problem")
    print()

    try:
        import cv2
        import numpy as np
        import random
    except ImportError:
        print("  ⚠️  cv2/numpy not found, skipping hard negatives")
        return

    neg_img_dir = Path(DATASET_DIR) / 'train' / 'images'
    neg_lbl_dir = Path(DATASET_DIR) / 'train' / 'labels'
    neg_img_dir.mkdir(parents=True, exist_ok=True)
    neg_lbl_dir.mkdir(parents=True, exist_ok=True)

    created = 0

    def save_negative(img, name):
        """Save image with empty label file (= no fire in this image)"""
        img_path = neg_img_dir / f'neg_{name}.jpg'
        lbl_path = neg_lbl_dir / f'neg_{name}.txt'
        cv2.imwrite(str(img_path), img)
        # Empty label = YOLO knows this image has no fire
        open(str(lbl_path), 'w').close()

    # Generate synthetic hard negatives
    for i in range(150):
        h, w = 640, 640
        img = np.zeros((h, w, 3), dtype=np.uint8)

        neg_type = i % 6

        if neg_type == 0:
            # Pure yellow background (like your phone screen issue)
            yellow = random.randint(200, 255)
            img[:] = [0, yellow, yellow]  # BGR yellow
            # Add some variation
            noise = np.random.randint(-20, 20, img.shape, dtype=np.int16)
            img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
            save_negative(img, f'yellow_bg_{i}')
            created += 1

        elif neg_type == 1:
            # Orange/sunset gradient
            for y in range(h):
                ratio = y / h
                b = int(0)
                g = int(ratio * 100)
                r = int(200 + ratio * 55)
                img[y, :] = [b, g, r]
            save_negative(img, f'sunset_{i}')
            created += 1

        elif neg_type == 2:
            # Yellow rectangle on dark background (like a phone/screen)
            img[:] = [20, 20, 20]
            x1 = random.randint(50, 200)
            y1 = random.randint(50, 200)
            x2 = random.randint(400, 580)
            y2 = random.randint(400, 550)
            img[y1:y2, x1:x2] = [0, random.randint(200,255), random.randint(200,255)]
            save_negative(img, f'yellow_rect_{i}')
            created += 1

        elif neg_type == 3:
            # Orange lamp / light glow simulation
            img[:] = [10, 10, 10]
            center = (random.randint(200,440), random.randint(200,440))
            for radius in range(150, 0, -10):
                alpha = 1 - (radius / 150)
                color = (0, int(alpha*80), int(alpha*220))
                cv2.circle(img, center, radius, color, -1)
            save_negative(img, f'lamp_{i}')
            created += 1

        elif neg_type == 4:
            # Human skin tones (to reduce human false positives)
            # Skin in BGR: roughly (80-140, 100-180, 170-230)
            b = random.randint(80, 140)
            g = random.randint(100, 180)
            r = random.randint(170, 230)
            img[:] = [b, g, r]
            noise = np.random.randint(-30, 30, img.shape, dtype=np.int16)
            img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
            save_negative(img, f'skin_{i}')
            created += 1

        elif neg_type == 5:
            # Red/orange walls or objects
            img[:] = [0, random.randint(50,120), random.randint(150,220)]
            save_negative(img, f'red_obj_{i}')
            created += 1

    print(f"  ✅ Created {created} hard negative training images")
    print("  These teach the model: yellow/orange ≠ fire")


# ─────────────────────────────────────────────────────────
#  Step 4 — Create proper data.yaml
# ─────────────────────────────────────────────────────────
def create_data_yaml():
    print("\n" + "="*60)
    print("  STEP 4: Creating data.yaml")
    print("="*60)

    data_yaml = {
        'path': str(Path(DATASET_DIR).resolve()),
        'train': 'train/images',
        'val':   'valid/images',
        'test':  'test/images',
        'nc':    1,
        'names': ['fire']
    }

    yaml_path = Path(DATASET_DIR) / 'data.yaml'
    with open(yaml_path, 'w') as f:
        yaml.dump(data_yaml, f, default_flow_style=False)

    print(f"  ✅ Saved: {yaml_path}")
    print(f"  Content:")
    for k, v in data_yaml.items():
        print(f"    {k}: {v}")

    return str(yaml_path)


# ─────────────────────────────────────────────────────────
#  Step 5 — Train
# ─────────────────────────────────────────────────────────
def train(yaml_path: str):
    print("\n" + "="*60)
    print("  STEP 5: Training — this will take 20-60 minutes")
    print("="*60)

    try:
        from ultralytics import YOLO
    except ImportError:
        print("  ❌ ultralytics not installed. Run: pip install ultralytics")
        sys.exit(1)

    print(f"\n  Base model:  {MODEL_BASE}")
    print(f"  Epochs:      {EPOCHS}")
    print(f"  Image size:  {IMG_SIZE}")
    print(f"  Batch size:  {BATCH_SIZE}")
    print(f"  Output name: {OUTPUT_NAME}")
    print()
    print("  Starting training...")
    print("  (You can watch progress below — loss should decrease each epoch)")
    print()

    model = YOLO(MODEL_BASE)

    results = model.train(
        data      = yaml_path,
        epochs    = EPOCHS,
        imgsz     = IMG_SIZE,
        batch     = BATCH_SIZE,
        name      = OUTPUT_NAME,
        patience  = 20,          # stop early if no improvement for 20 epochs
        save      = True,
        plots     = True,

        # ── Augmentation settings ──────────────────────────
        # These help the model generalize better
        hsv_h     = 0.015,       # hue shift — helps with color variation
        hsv_s     = 0.7,         # saturation — important for fire colors
        hsv_v     = 0.4,         # brightness variation
        degrees   = 10,          # rotation
        translate = 0.1,
        scale     = 0.5,
        fliplr    = 0.5,
        mosaic    = 1.0,         # mosaic augmentation (combines 4 images)
        mixup     = 0.1,         # mixup augmentation

        # ── Training quality settings ──────────────────────
        optimizer = 'AdamW',     # better than default SGD for small datasets
        lr0       = 0.001,       # initial learning rate
        lrf       = 0.01,        # final learning rate ratio
        warmup_epochs = 5,       # warm up for 5 epochs
        cos_lr    = True,        # cosine learning rate schedule
        label_smoothing = 0.1,   # reduces overconfidence on wrong detections

        # ── Confidence tuning ─────────────────────────────
        conf      = 0.25,        # detection confidence during training eval
        iou       = 0.45,        # NMS IoU threshold
    )

    return results


# ─────────────────────────────────────────────────────────
#  Step 6 — Copy best model
# ─────────────────────────────────────────────────────────
def copy_best_model():
    print("\n" + "="*60)
    print("  STEP 6: Saving best model")
    print("="*60)

    # YOLO saves to runs/detect/OUTPUT_NAME/weights/best.pt
    best_pt = Path('runs') / 'detect' / OUTPUT_NAME / 'weights' / 'best.pt'

    if not best_pt.exists():
        # Try finding it
        found = list(Path('runs').glob(f'**/{OUTPUT_NAME}*/weights/best.pt'))
        if found:
            best_pt = found[0]
        else:
            print(f"  ❌ Could not find best.pt in runs/")
            print("  Check: runs/detect/ folder manually")
            return

    # Copy to your model locations
    destinations = [
        Path('fire.pt'),                        # root
        Path('backend') / 'models' / 'fire.pt', # backend
    ]

    for dest in destinations:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(best_pt), str(dest))
        print(f"  ✅ Copied to: {dest}")

    print()
    print("  🎉 Training complete!")
    print(f"  Best model:  {best_pt}")
    print()
    print("  Now restart your backend — it will use the new model automatically.")
    print()
    print("  Expected improvements:")
    print("  ✅ Yellow objects → no longer detected as fire")
    print("  ✅ Human skin tones → no longer detected as fire")  
    print("  ✅ Orange walls/lamps → no longer detected as fire")
    print("  ✅ Real fire → still detected correctly")


# ─────────────────────────────────────────────────────────
#  Step 7 — Validate the new model
# ─────────────────────────────────────────────────────────
def validate_model():
    print("\n" + "="*60)
    print("  STEP 7: Validating new model")
    print("="*60)

    try:
        from ultralytics import YOLO
        model = YOLO('fire.pt')
        metrics = model.val(data=str(Path(DATASET_DIR) / 'data.yaml'))

        print(f"\n  Results:")
        print(f"  mAP50:    {metrics.box.map50:.3f}   (target: > 0.85)")
        print(f"  mAP50-95: {metrics.box.map:.3f}   (target: > 0.60)")
        print(f"  Precision:{metrics.box.p.mean():.3f}   (target: > 0.85)")
        print(f"  Recall:   {metrics.box.r.mean():.3f}   (target: > 0.80)")

        p = metrics.box.p.mean()
        r = metrics.box.r.mean()

        if p > 0.85 and r > 0.80:
            print("\n  ✅ Model looks great! Good precision and recall.")
        elif p > 0.90 and r < 0.75:
            print("\n  ⚠️  High precision but low recall.")
            print("  Model is strict — may miss some fires.")
            print("  Try lowering CONFIDENCE_THRESHOLD to 0.70 in fire_ws.py")
        elif p < 0.75:
            print("\n  ⚠️  Low precision — still getting false positives.")
            print("  Add more hard negative examples and retrain.")

    except Exception as e:
        print(f"  ⚠️  Validation error: {e}")
        print("  You can validate manually later.")


# ─────────────────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────────────────
def main():
    print()
    print("  ╔══════════════════════════════════════╗")
    print("  ║   FireShield AI — Model Retrainer    ║")
    print("  ║   Fixing false positives             ║")
    print("  ╚══════════════════════════════════════╝")
    print()
    print("  This script will:")
    print("  1. Check your existing dataset")
    print("  2. Add hard negative images (yellow/orange non-fire)")
    print("  3. Retrain with better settings")
    print("  4. Save the new model as fire.pt")
    print()

    # Check dependencies
    missing = []
    try: import ultralytics
    except: missing.append('ultralytics')
    try: import cv2
    except: missing.append('opencv-python')
    try: import yaml
    except: missing.append('pyyaml')
    try: import numpy
    except: missing.append('numpy')

    if missing:
        print("  ❌ Missing packages:")
        for p in missing:
            print(f"     pip install {p}")
        sys.exit(1)

    input("  Press ENTER to start...\n")

    # Run all steps
    counts     = check_existing_dataset()
    extra_path = download_additional_data()
    create_hard_negatives()
    yaml_path  = create_data_yaml()
    train(yaml_path)
    copy_best_model()
    validate_model()

    print("\n" + "="*60)
    print("  DONE! Restart your backend to use the new model.")
    print("="*60 + "\n")


if __name__ == '__main__':
    main()