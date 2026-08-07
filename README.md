# opi

**o(verpowered)pi**

A collection of extensions for [Pi](https://github.com/earendil-works/pi).

## Packages

- [opi-subagents](packages/subagents): isolated task and review subagents
- [opi-scheduler](packages/scheduler): recurring Pi tasks backed by `launchd` or systemd

## Install

Clone the repository:

```sh
git clone https://github.com/crisog/opi.git
cd opi
```

Then install whichever packages you want:

```sh
pi install ./packages/subagents
pi install ./packages/scheduler
```

Pi records these as local packages, so keep the checkout and use `git pull` to update it. See each package's README for usage and platform requirements.
