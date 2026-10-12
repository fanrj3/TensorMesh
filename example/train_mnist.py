#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import Adam
from torch.utils.data import DataLoader
from torchvision import datasets, transforms


class MnistCnn(nn.Module):
  def __init__(self) -> None:
    super().__init__()
    self.conv1 = nn.Conv2d(1, 32, 3, 1)
    self.conv2 = nn.Conv2d(32, 64, 3, 1)
    self.dropout1 = nn.Dropout(0.25)
    self.dropout2 = nn.Dropout(0.5)
    self.fc1 = nn.Linear(9216, 128)
    self.fc2 = nn.Linear(128, 10)

  def forward(self, x: torch.Tensor) -> torch.Tensor:
    x = self.conv1(x)
    x = F.relu(x)
    x = self.conv2(x)
    x = F.relu(x)
    x = F.max_pool2d(x, 2)
    x = self.dropout1(x)
    x = torch.flatten(x, 1)
    x = self.fc1(x)
    x = F.relu(x)
    x = self.dropout2(x)
    x = self.fc2(x)
    return F.log_softmax(x, dim=1)


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Train a small CNN on MNIST.")
  parser.add_argument("--data-dir", type=Path, default=Path("example/data"))
  parser.add_argument("--output-dir", type=Path, default=Path("example/runs/mnist"))
  parser.add_argument("--epochs", type=int, default=2)
  parser.add_argument("--batch-size", type=int, default=128)
  parser.add_argument("--test-batch-size", type=int, default=512)
  parser.add_argument("--lr", type=float, default=1e-3)
  parser.add_argument("--seed", type=int, default=42)
  parser.add_argument("--num-workers", type=int, default=2)
  parser.add_argument("--download", dest="download", action="store_true", default=True)
  parser.add_argument("--no-download", dest="download", action="store_false")
  parser.add_argument("--log-interval", type=int, default=100)
  parser.add_argument("--limit-train-batches", type=int, default=0)
  parser.add_argument("--limit-test-batches", type=int, default=0)
  return parser.parse_args()


def set_seed(seed: int) -> None:
  random.seed(seed)
  torch.manual_seed(seed)
  if torch.cuda.is_available():
    torch.cuda.manual_seed_all(seed)


def train_epoch(
  model: nn.Module,
  device: torch.device,
  loader: DataLoader,
  optimizer: torch.optim.Optimizer,
  epoch: int,
  log_interval: int,
  limit_batches: int = 0,
) -> tuple[float, float]:
  model.train()
  total_loss = 0.0
  correct = 0
  seen = 0
  for batch_idx, (data, target) in enumerate(loader, start=1):
    if limit_batches and batch_idx > limit_batches:
      break
    data = data.to(device, non_blocking=True)
    target = target.to(device, non_blocking=True)
    optimizer.zero_grad(set_to_none=True)
    output = model(data)
    loss = F.nll_loss(output, target)
    loss.backward()
    optimizer.step()

    total_loss += loss.item() * data.size(0)
    pred = output.argmax(dim=1)
    correct += pred.eq(target).sum().item()
    seen += data.size(0)

    if batch_idx % log_interval == 0:
      print(
        f"epoch={epoch} step={batch_idx}/{len(loader)} "
        f"loss={loss.item():.4f} acc={correct / max(1, seen):.4f}",
        flush=True,
      )
  return total_loss / max(1, seen), correct / max(1, seen)


@torch.no_grad()
def evaluate(model: nn.Module, device: torch.device, loader: DataLoader, limit_batches: int = 0) -> tuple[float, float]:
  model.eval()
  total_loss = 0.0
  correct = 0
  seen = 0
  for batch_idx, (data, target) in enumerate(loader, start=1):
    if limit_batches and batch_idx > limit_batches:
      break
    data = data.to(device, non_blocking=True)
    target = target.to(device, non_blocking=True)
    output = model(data)
    total_loss += F.nll_loss(output, target, reduction="sum").item()
    pred = output.argmax(dim=1)
    correct += pred.eq(target).sum().item()
    seen += data.size(0)
  return total_loss / max(1, seen), correct / max(1, seen)


def main() -> int:
  args = parse_args()
  set_seed(args.seed)
  args.output_dir.mkdir(parents=True, exist_ok=True)
  args.data_dir.mkdir(parents=True, exist_ok=True)

  device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
  print(f"device={device}", flush=True)
  print(f"cuda_visible_devices={os.environ.get('CUDA_VISIBLE_DEVICES', '-')}", flush=True)
  if torch.cuda.is_available():
    print(f"gpu={torch.cuda.get_device_name(0)}", flush=True)

  transform = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize((0.1307,), (0.3081,)),
  ])
  try:
    train_set = datasets.MNIST(str(args.data_dir), train=True, download=args.download, transform=transform)
    test_set = datasets.MNIST(str(args.data_dir), train=False, download=args.download, transform=transform)
  except RuntimeError as error:
    print(
      "Failed to load MNIST. If this machine cannot access the internet, "
      "download MNIST once into example/data/MNIST/raw and rerun with --no-download.",
      file=sys.stderr,
      flush=True,
    )
    raise error
  pin_memory = device.type == "cuda"
  train_loader = DataLoader(
    train_set,
    batch_size=args.batch_size,
    shuffle=True,
    num_workers=args.num_workers,
    pin_memory=pin_memory,
  )
  test_loader = DataLoader(
    test_set,
    batch_size=args.test_batch_size,
    shuffle=False,
    num_workers=args.num_workers,
    pin_memory=pin_memory,
  )
  model = MnistCnn().to(device)
  optimizer = Adam(model.parameters(), lr=args.lr)
  history = []
  started_at = time.time()
  for epoch in range(1, args.epochs + 1):
    train_loss, train_acc = train_epoch(
      model,
      device,
      train_loader,
      optimizer,
      epoch,
      args.log_interval,
      args.limit_train_batches,
    )
    test_loss, test_acc = evaluate(model, device, test_loader, args.limit_test_batches)
    row = {
      "epoch": epoch,
      "train_loss": train_loss,
      "train_acc": train_acc,
      "test_loss": test_loss,
      "test_acc": test_acc,
    }
    history.append(row)
    print(
      f"epoch={epoch} train_loss={train_loss:.4f} train_acc={train_acc:.4f} "
      f"test_loss={test_loss:.4f} test_acc={test_acc:.4f}",
      flush=True,
    )

  checkpoint = args.output_dir / "mnist_cnn.pt"
  metrics = args.output_dir / "metrics.json"
  torch.save({"model": model.state_dict(), "args": vars(args), "history": history}, checkpoint)
  metrics.write_text(json.dumps({
    "device": str(device),
    "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES", "-"),
    "seconds": round(time.time() - started_at, 2),
    "history": history,
    "checkpoint": str(checkpoint),
  }, indent=2), encoding="utf-8")
  print(f"saved_checkpoint={checkpoint}", flush=True)
  print(f"saved_metrics={metrics}", flush=True)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
